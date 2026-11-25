/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest response bodies are untyped JSON */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildCatalogTestApp, type CatalogTestApp } from '../../testing/catalog.js';
import { createTestDatabase, type TestDatabase } from '../../testing/database.js';
import { jsonResponse } from '../../testing/sources.js';

/** The name and synopsis of one episode: fetched from Jikan the first time, kept after that. */
describe('episode info (GET /titles/:titleId/episodes/:episode)', () => {
  let testDb: TestDatabase;
  let t: CatalogTestApp;
  let auth: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
  });
  afterAll(async () => {
    await testDb.drop();
  });
  beforeEach(async () => {
    await testDb.reset();
    t = await buildCatalogTestApp({ db: testDb.db.client });
    ({ auth } = await t.signIn());
  });

  const newTitle = async (withMal: boolean): Promise<string> => {
    const id = (
      await testDb.sql.query<{ id: string }>(
        `INSERT INTO title (kind, status, title_romaji, fetched_at, detail_fetched_at)
         VALUES ('tv', 'finished', 'Episode show', now(), now()) RETURNING id`,
      )
    ).rows[0]!.id;
    if (withMal) {
      await testDb.sql.query(
        `INSERT INTO title_external_id (title_id, source, external_id) VALUES ($1, 'mal', '4242')`,
        [id],
      );
    }
    return id;
  };
  const jikanCalls = () =>
    t.jikan.requests.filter((request) => new URL(request.url).pathname.includes('/episodes/'));
  const answering = (body: unknown, status = 200) => {
    t.jikan.responder = () => jsonResponse(status, body);
  };

  it('fetches the name and synopsis once, then answers from the database', async () => {
    const id = await newTitle(true);
    answering({
      data: {
        mal_id: 3,
        title: 'The third one',
        synopsis: 'Something happens.\n\n[Written by MAL]',
      },
    });
    const first = await t.get(`/titles/${id}/episodes/3`, auth);
    expect(first.status).toBe(200);
    const data = first.body.data as {
      episode: number;
      name: string | null;
      synopsis: string | null;
    };
    expect(data).toMatchObject({ episode: 3, name: 'The third one' });
    expect(data.synopsis).toContain('Something happens.');
    expect(new URL(jikanCalls()[0]!.url).pathname).toBe('/v4/anime/4242/episodes/3');

    const second = await t.get(`/titles/${id}/episodes/3`, auth);
    expect(second.body.data.name).toBe('The third one');
    expect(jikanCalls()).toHaveLength(1);
  });

  it('answers with nothing, not an error, when the source has no such episode, and does not ask again for a day', async () => {
    const id = await newTitle(true);
    answering({ status: 404 }, 404);
    const first = await t.get(`/titles/${id}/episodes/9`, auth);
    expect(first.status).toBe(200);
    expect(first.body.data).toEqual({ episode: 9, name: null, synopsis: null });
    await t.get(`/titles/${id}/episodes/9`, auth);
    expect(jikanCalls()).toHaveLength(1);
  });

  it('asks again later when the source was down, and stores nothing meanwhile', async () => {
    const id = await newTitle(true);
    answering({}, 503);
    const down = await t.get(`/titles/${id}/episodes/1`, auth);
    expect(down.status).toBe(200);
    expect(down.body.data).toEqual({ episode: 1, name: null, synopsis: null });
    expect(
      (await testDb.sql.query('SELECT 1 FROM episode_info WHERE title_id = $1', [id])).rowCount,
    ).toBe(0);
    answering({ data: { mal_id: 1, title: 'Back again', synopsis: null } });
    expect((await t.get(`/titles/${id}/episodes/1`, auth)).body.data.name).toBe('Back again');
  });

  it('says nothing for a title with no MyAnimeList id, without asking anyone', async () => {
    const id = await newTitle(false);
    const response = await t.get(`/titles/${id}/episodes/1`, auth);
    expect(response.body.data).toEqual({ episode: 1, name: null, synopsis: null });
    expect(jikanCalls()).toHaveLength(0);
  });

  it('404s for an unknown title, 422s for a bad episode number, and needs a signed-in user', async () => {
    expect(
      (await t.get('/titles/00000000-0000-4000-8000-000000000000/episodes/1', auth)).status,
    ).toBe(404);
    const id = await newTitle(true);
    expect((await t.get(`/titles/${id}/episodes/0`, auth)).status).toBe(422);
    expect((await t.get(`/titles/${id}/episodes/abc`, auth)).status).toBe(422);
    expect((await t.get(`/titles/${id}/episodes/1`, 'Bearer not-a-token')).status).toBe(401);
  });
});
