import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDbCheck } from '../lib/dbCheck.js';
import { createTestDatabase, type TestDatabase } from '../testing/database.js';
import { dropDatabase } from '../testing/databaseAdmin.js';
import { buildTestApp } from '../testing/harness.js';
import { createDb, type Db } from './index.js';

let testDb: TestDatabase;
const extra: Db[] = [];

/** A handle on a variation of the test database URL; closed in afterAll. */
function dbWith(change: (url: URL) => void, options: { connectionTimeoutMs?: number } = {}): Db {
  const url = new URL(testDb.url);
  change(url);
  const db = createDb({ databaseUrl: url.toString(), maxConnections: 1, ...options });
  extra.push(db);
  return db;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
});

afterAll(async () => {
  await Promise.all(extra.map((db) => db.close().catch(() => undefined)));
  await testDb.drop();
});

describe('db module', () => {
  it('ping runs a query against the real database', async () => {
    await expect(testDb.db.ping()).resolves.toBeUndefined();
    await expect(createDbCheck(testDb.db)()).resolves.toBe('ok');
  });

  it('accepts the Prisma-style ?schema=public parameter', async () => {
    const db = dbWith((url) => url.searchParams.set('schema', 'public'));

    await expect(db.ping()).resolves.toBeUndefined();
    await expect(db.client.genre.count()).resolves.toBe(0);
  });

  it('honours a non-default ?schema= for both model queries and raw SQL', async () => {
    await testDb.sql.query('CREATE SCHEMA other_schema');
    await testDb.sql.query('CREATE TABLE other_schema.genre (LIKE public.genre INCLUDING ALL)');
    await testDb.sql.query(`INSERT INTO other_schema.genre (name) VALUES ('Only Here')`);
    const db = dbWith((url) => url.searchParams.set('schema', 'other_schema'));

    await expect(db.client.genre.findMany({ select: { name: true } })).resolves.toEqual([
      { name: 'Only Here' },
    ]);
    await expect(db.client.$queryRaw`SELECT name FROM genre`).resolves.toEqual([
      { name: 'Only Here' },
    ]);
    await expect(testDb.db.client.genre.count()).resolves.toBe(0);
  });

  it('rejects a schema parameter that is not a plain identifier', () => {
    const url = new URL(testDb.url);
    url.searchParams.set('schema', 'x; DROP SCHEMA public');
    expect(() => createDb({ databaseUrl: url.toString() })).toThrow(/plain identifier/);
  });

  it('creating a handle does not connect; ping rejects when nothing listens', async () => {
    const db = dbWith((url) => {
      url.hostname = '127.0.0.1';
      url.port = '1';
    });
    await expect(db.ping()).rejects.toThrow();
  });

  it('ping rejects for a wrong password and for a database that does not exist', async () => {
    const wrongPassword = dbWith((url) => {
      url.password = 'not-the-password';
    });
    const missingDatabase = dbWith((url) => {
      url.pathname = '/akiba_t_does_not_exist';
    });

    await expect(wrongPassword.ping()).rejects.toThrow();
    await expect(missingDatabase.ping()).rejects.toThrow();
  });

  it('close releases every pooled connection', async () => {
    const url = new URL(testDb.url);
    url.searchParams.set('application_name', 'akiba-close-test');
    const db = createDb({ databaseUrl: url.toString(), maxConnections: 2 });
    const connections = async (): Promise<number> => {
      const result = await testDb.sql.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'akiba-close-test'`,
      );
      return result.rows[0]?.n ?? -1;
    };

    await db.ping();
    expect(await connections()).toBe(1);

    await db.close();
    // The backend exits asynchronously after the client says goodbye.
    await expect.poll(connections, { timeout: 5_000 }).toBe(0);
  });
});

describe('GET /ready with the real database check (doc 07 §7)', () => {
  it('is 200 with database "ok" when SELECT 1 succeeds', async () => {
    const { app } = buildTestApp({ checkDb: createDbCheck(testDb.db) });

    const response = await request(app).get('/ready');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'ready',
      checks: { database: 'ok', sources: 'not_configured' },
    });
  });

  it.each([
    [
      'nothing listens on the port',
      (url: URL) => {
        url.hostname = '127.0.0.1';
        url.port = '1';
      },
    ],
    [
      'the password is wrong',
      (url: URL) => {
        url.password = 'wrong-secret-pw';
      },
    ],
    [
      'the database does not exist',
      (url: URL) => {
        url.pathname = '/akiba_t_does_not_exist';
      },
    ],
  ])('is 503 problem+json when %s, without leaking the cause', async (_name, change) => {
    const db = dbWith(change);
    const { app, logs } = buildTestApp({ checkDb: createDbCheck(db) });

    const response = await request(app).get('/ready');

    expect(response.status).toBe(503);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(response.body).toMatchObject({
      status: 503,
      code: 'NOT_READY',
      checks: { database: 'unavailable', sources: 'not_configured' },
    });
    const password = decodeURIComponent(new URL(testDb.url).password);
    expect(response.text).not.toContain('akiba_t_');
    expect(response.text).not.toContain('127.0.0.1');
    // The reason is logged for operators, but never the credentials.
    expect(logs.text).toContain('readiness: database check failed');
    expect(logs.text).not.toContain(password);
    expect(logs.text).not.toContain('wrong-secret-pw');
    // Liveness is unaffected.
    expect((await request(app).get('/health')).status).toBe(200);
  });

  it('turns 503 when the database goes away while the API is running, and the API survives', async () => {
    const victim = await createTestDatabase();
    try {
      const { app } = buildTestApp({ checkDb: createDbCheck(victim.db) });
      expect((await request(app).get('/ready')).status).toBe(200);

      // Force-dropping the database terminates the pooled connection, like a server going down.
      await dropDatabase(inject('testDatabase').serverUrl, victim.name);

      expect((await request(app).get('/ready')).status).toBe(503);
      expect((await request(app).get('/ready')).status).toBe(503);
      expect((await request(app).get('/health')).status).toBe(200);
    } finally {
      await victim.drop();
    }
  });
});
