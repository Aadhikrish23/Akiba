/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest response bodies are untyped JSON; this suite reads them field by field */
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCatalogTestApp, type CatalogTestApp } from '../testing/catalog.js';
import { createTestDatabase, type TestDatabase } from '../testing/database.js';

/**
 * T20 (doc 11 §3.2): the access-control suite is GENERATED from the route table the running app
 * actually serves, not from a list someone remembered to keep up to date. Adding a route without
 * deciding how it is protected fails here:
 *
 *  - every route must be classified (public, or private);
 *  - every private route answers 401 without a token and with a forged one;
 *  - every private route that takes an `:entryId` answers 404 (and changes nothing) when it is
 *    someone else's entry, with the same body whether the entry exists or not.
 */

interface Layer {
  readonly route?: { readonly path: string; readonly methods: Record<string, boolean> };
  readonly handle?: { readonly stack?: readonly Layer[] };
  readonly slash?: boolean;
  readonly matchers?: readonly ((path: string) => unknown)[];
}

interface RouteInfo {
  readonly method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  /** The full path as a client sees it, e.g. `/v1/library/:entryId`. */
  readonly path: string;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/** Every route of the app (Express 5 keeps the table on `app.router`), with its mount prefix. */
function routeTable(app: Express): RouteInfo[] {
  const found: RouteInfo[] = [];
  const walk = (stack: readonly Layer[], prefix: string): void => {
    for (const layer of stack) {
      if (layer.route) {
        for (const method of METHODS) {
          if (layer.route.methods[method] === true) {
            found.push({ method, path: prefix + layer.route.path });
          }
        }
      } else if (layer.handle?.stack) {
        // A mounted router: a root mount has no prefix; otherwise its matcher reports the prefix it took.
        let mount: string | null = layer.slash === true ? '' : null;
        for (const probe of ['/v1/x', '/auth/x', '/health/x', '/ready/x']) {
          const hit = layer.matchers?.map((m) => m(probe)).find((r) => r !== false);
          if (mount === null && hit !== undefined) mount = (hit as { path: string }).path;
        }
        if (mount === null) throw new Error('A router is mounted at a path this suite cannot read');
        walk(layer.handle.stack, prefix + mount);
      }
    }
  };
  walk((app as unknown as { router: { stack: readonly Layer[] } }).router.stack, '');
  return found;
}

const key = (route: RouteInfo): string => `${route.method.toUpperCase()} ${route.path}`;

/** Routes that are public on purpose. Each needs a reason: this is the list a reviewer reads. */
const PUBLIC: Readonly<Record<string, string>> = {
  'GET /health': 'liveness probe',
  'GET /ready': 'readiness probe',
  'POST /v1/auth/register': 'sign-up',
  'POST /v1/auth/login': 'sign-in',
  'POST /v1/auth/refresh': 'the refresh token is its own credential',
  'POST /v1/auth/logout': 'the refresh token is its own credential',
  'POST /v1/auth/restore': 'password-checked, for an account in its grace period',
  'POST /v1/auth/verify-email': 'a one-time token is the credential',
  'POST /v1/auth/password/forgot': 'answers the same for every address',
  'POST /v1/auth/password/reset': 'a one-time token is the credential',
  'GET /v1/shared/:token': 'an unguessable share token is the credential; uniform 404',
};

/** A valid body for every private route that takes an entry ID (so validation passes first). */
const ENTRY_BODIES: Readonly<Record<string, object | null>> = {
  'GET /v1/library/:entryId': null,
  'PATCH /v1/library/:entryId': { rating: 1 },
  'DELETE /v1/library/:entryId': null,
  'POST /v1/library/:entryId/progress': { delta: 1 },
  'PUT /v1/library/:entryId/episodes-total': { total: 99 },
  'DELETE /v1/library/:entryId/episodes-total': null,
  'POST /v1/library/:entryId/runs': null,
};

const NIL_UUID = '00000000-0000-4000-8000-000000000000';
const fill = (path: string, values: Record<string, string>): string =>
  path.replace(/:(\w+)/g, (_, name: string) => values[name] ?? NIL_UUID);

describe('route table access control (T20, doc 11 §3.2)', () => {
  let testDb: TestDatabase;
  let t: CatalogTestApp;
  let routes: RouteInfo[];
  let isPrivate: (route: RouteInfo) => boolean;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    t = await buildCatalogTestApp({ db: testDb.db.client });
    routes = routeTable(t.app);
    isPrivate = (route) => PUBLIC[key(route)] === undefined;
  });
  afterAll(async () => {
    await testDb.drop();
  });

  it('serves a known set of routes, each one classified', () => {
    expect(routes.length).toBeGreaterThan(30); // a walker that finds nothing must not pass quietly
    const keys = routes.map(key);
    expect(new Set(keys).size).toBe(keys.length);
    // A public entry that matches no route is stale; delete it.
    for (const listed of Object.keys(PUBLIC)) {
      if (!listed.includes('/health') && !listed.includes('/ready')) {
        expect(keys, `stale public entry ${listed}`).toContain(listed);
      }
    }
    // Every private route with an entry ID has a body for the attack below.
    const entryRoutes = routes.filter(
      (route) => isPrivate(route) && route.path.includes(':entryId'),
    );
    expect(entryRoutes.map(key).sort()).toEqual(Object.keys(ENTRY_BODIES).sort());
  });

  it('every private route answers 401 without a token, and with a forged or malformed one', async () => {
    const results: string[] = [];
    for (const route of routes.filter((r) => isPrivate(r) && r.path.startsWith('/v1'))) {
      const url = fill(route.path, {});
      const none = await request(t.app)[route.method](url);
      const forged = await request(t.app)
        [route.method](url)
        .set('Authorization', 'Bearer abc.def.ghi');
      const wrongScheme = await request(t.app)
        [route.method](url)
        .set('Authorization', 'Basic Zm9vOmJhcg==');
      for (const [label, response] of [
        ['no token', none],
        ['forged token', forged],
        ['wrong scheme', wrongScheme],
      ] as const) {
        if (response.status !== 401)
          results.push(`${key(route)} (${label}) answered ${response.status}`);
        else expect(response.type).toBe('application/problem+json');
      }
    }
    expect(results).toEqual([]);
  });

  it("a second user gets the same 404 for someone else's entry as for one that never existed, with no side effects", async () => {
    const owner = await t.signIn('owner');
    const intruder = await t.signIn('intruder');
    const titleId = (
      await testDb.sql.query<{ id: string }>(
        `INSERT INTO title (kind, status, title_romaji, episodes_total, fetched_at, detail_fetched_at)
         VALUES ('tv', 'finished', 'Owned', 12, now(), now()) RETURNING id`,
      )
    ).rows[0]!.id;
    const added = await request(t.app)
      .post('/v1/library')
      .set('Authorization', owner.auth)
      .send({ titleId, status: 'watching' });
    expect(added.status).toBe(201);
    const entryId = added.body.data.id as string;

    const dump = async () =>
      JSON.stringify([
        (await testDb.sql.query('SELECT * FROM library_entry ORDER BY id')).rows,
        (await testDb.sql.query('SELECT * FROM event ORDER BY seq')).rows,
        (await testDb.sql.query('SELECT * FROM viewing_run ORDER BY id')).rows,
      ]);
    const before = await dump();

    const failures: string[] = [];
    for (const [signature, body] of Object.entries(ENTRY_BODIES)) {
      const route = routes.find((r) => key(r) === signature)!;
      const send = (id: string) => {
        const req = request(t.app)
          [route.method](fill(route.path, { entryId: id }))
          .set('Authorization', intruder.auth);
        return body === null ? req : req.send(body);
      };
      const theirs = await send(entryId);
      const missing = await send(NIL_UUID);
      if (theirs.status !== 404)
        failures.push(`${signature} on another user's entry: ${theirs.status}`);
      if (missing.status !== 404)
        failures.push(`${signature} on a missing entry: ${missing.status}`);
      // Indistinguishable: an attacker learns nothing about which IDs exist.
      if (theirs.status === 404 && missing.status === 404) {
        const strip = (res: request.Response): object => ({
          ...(res.body as object),
          instance: undefined,
          requestId: undefined,
        });
        if (JSON.stringify(strip(theirs)) !== JSON.stringify(strip(missing))) {
          failures.push(`${signature}: the two 404 bodies differ`);
        }
      }
    }
    expect(failures).toEqual([]);
    expect(await dump()).toBe(before);

    // …and the owner still has it, untouched.
    const still = await request(t.app)
      .get(`/v1/library/${entryId}`)
      .set('Authorization', owner.auth);
    expect(still.body.data).toMatchObject({ progress: 0, rating: null, status: 'watching' });
  });

  it("listings never include another user's data (library, favourites, counts, history, export)", async () => {
    const owner = await t.signIn('owner-two');
    const intruder = await t.signIn('intruder-two');
    const titleId = (
      await testDb.sql.query<{ id: string }>(
        `INSERT INTO title (kind, status, title_romaji, episodes_total, fetched_at, detail_fetched_at)
         VALUES ('tv', 'finished', 'Secret Shelf Item', 12, now(), now()) RETURNING id`,
      )
    ).rows[0]!.id;
    const entry = await request(t.app)
      .post('/v1/library')
      .set('Authorization', owner.auth)
      .send({ titleId, status: 'watching' });
    await request(t.app)
      .patch(`/v1/library/${entry.body.data.id}`)
      .set('Authorization', owner.auth)
      .send({ isFavorite: true, review: 'Owner-only words', rating: 8 });

    for (const path of [
      '/v1/library',
      '/v1/library/favorites',
      '/v1/library/counts',
      '/v1/history',
    ]) {
      const response = await request(t.app).get(path).set('Authorization', intruder.auth);
      expect(response.status, path).toBe(200);
      expect(response.text, path).not.toContain('Secret Shelf Item');
      expect(response.text, path).not.toContain('Owner-only words');
    }
    const exported = await request(t.app).post('/v1/me/export').set('Authorization', intruder.auth);
    expect(exported.text).not.toContain('Secret Shelf Item');
    expect(exported.text).not.toContain('Owner-only words');
  });
});
