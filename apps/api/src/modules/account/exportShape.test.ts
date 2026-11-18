/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest response bodies are untyped JSON; this suite reads them field by field */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCatalogTestApp, type CatalogTestApp } from '../../testing/catalog.js';
import { createTestDatabase, type TestDatabase } from '../../testing/database.js';

/** The shape of a JSON value: keys and kinds, never the values (which change on every run). */
function shapeOf(value: unknown): unknown {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    // Elements of one list can differ (events have different payloads); show each distinct shape.
    const shapes = new Map<string, unknown>();
    for (const item of value) shapes.set(JSON.stringify(shapeOf(item)), shapeOf(item));
    return [...shapes.values()];
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, inner]) => [key, shapeOf(inner)]),
    );
  }
  return typeof value;
}

/**
 * T20 (doc 11 §3.3): the export is a promise to the user, so its format is pinned. Adding or removing
 * a field changes this snapshot on purpose: that is the moment to bump `exportVersion`, update doc 07,
 * and think about whether the new field belongs in a file the user keeps.
 */
describe('export format snapshot (T20, FR-EXPT-001)', () => {
  let testDb: TestDatabase;
  let t: CatalogTestApp;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    t = await buildCatalogTestApp({ db: testDb.db.client });
  });
  afterAll(async () => {
    await testDb.drop();
  });

  it('keeps the same fields, for a full account', async () => {
    const { auth } = await t.signIn('exporter');
    const titleId = (
      await testDb.sql.query<{ id: string }>(
        `INSERT INTO title (kind, status, title_romaji, episodes_total, fetched_at, detail_fetched_at)
         VALUES ('tv', 'finished', 'Shape', 12, now(), now()) RETURNING id`,
      )
    ).rows[0]!.id;
    await testDb.sql.query(
      `INSERT INTO title_external_id (title_id, source, external_id) VALUES ($1, 'anilist', '1')`,
      [titleId],
    );
    const send = (method: 'post' | 'patch', path: string, body?: object) => {
      const req = request(t.app)[method](`/v1${path}`).set('Authorization', auth);
      return body === undefined ? req : req.send(body);
    };
    const entry = await send('post', '/library', { titleId, status: 'watching' });
    const id = entry.body.data.id as string;
    await send('post', `/library/${id}/progress`, { delta: 2 });
    await send('patch', `/library/${id}`, {
      rating: 7,
      review: 'r',
      notes: 'n',
      isFavorite: true,
    });
    await send('patch', `/library/${id}`, { status: 'completed' });

    const response = await send('post', '/me/export');
    expect(response.status).toBe(200);
    const file = JSON.parse(response.text) as unknown;
    expect(shapeOf(file)).toMatchInlineSnapshot(`
      {
        "entries": [
          {
            "addedAt": "string",
            "alertsEnabled": "null",
            "completedAt": "string",
            "episodesTotalOverride": "null",
            "id": "string",
            "isFavorite": "boolean",
            "notes": "string",
            "progress": "number",
            "rating": "number",
            "removedAt": "null",
            "review": "string",
            "runs": [
              {
                "finishedAt": "string",
                "progressAtEnd": "number",
                "rating": "number",
                "runNumber": "number",
                "startedAt": "string",
              },
            ],
            "startedAt": "string",
            "status": "string",
            "title": {
              "akibaId": "string",
              "english": "null",
              "externalIds": [
                {
                  "externalId": "string",
                  "source": "string",
                },
              ],
              "kind": "string",
              "native": "null",
              "romaji": "string",
              "seasonYear": "null",
            },
            "updatedAt": "string",
          },
        ],
        "events": [
          {
            "entryId": "string",
            "id": "string",
            "occurredAt": "string",
            "payload": {
              "status": "string",
            },
            "runNumber": "null",
            "type": "string",
          },
          {
            "entryId": "string",
            "id": "string",
            "occurredAt": "string",
            "payload": {
              "run_number": "number",
            },
            "runNumber": "number",
            "type": "string",
          },
          {
            "entryId": "string",
            "id": "string",
            "occurredAt": "string",
            "payload": {
              "from": "number",
              "run": "number",
              "to": "number",
            },
            "runNumber": "number",
            "type": "string",
          },
          {
            "entryId": "string",
            "id": "string",
            "occurredAt": "string",
            "payload": {},
            "runNumber": "null",
            "type": "string",
          },
          {
            "entryId": "string",
            "id": "string",
            "occurredAt": "string",
            "payload": {
              "from": "null",
              "to": "number",
            },
            "runNumber": "null",
            "type": "string",
          },
          {
            "entryId": "string",
            "id": "string",
            "occurredAt": "string",
            "payload": {
              "length": "number",
            },
            "runNumber": "null",
            "type": "string",
          },
          {
            "entryId": "string",
            "id": "string",
            "occurredAt": "string",
            "payload": {
              "from": "string",
              "to": "string",
            },
            "runNumber": "null",
            "type": "string",
          },
        ],
        "exportVersion": "number",
        "exportedAt": "string",
        "favorites": [
          "string",
        ],
        "settings": {
          "alertsEnabled": "boolean",
          "libraryView": "string",
          "showAdult": "boolean",
          "timeZone": "string",
          "titleLanguage": "string",
        },
        "user": {
          "createdAt": "string",
          "displayName": "string",
          "email": "string",
        },
      }
    `);
  });
});
