/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- supertest response bodies are untyped JSON */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildCatalogTestApp, type CatalogTestApp } from '../../testing/catalog.js';
import { createTestDatabase, type TestDatabase } from '../../testing/database.js';

describe('library counts and entry IDs on cards (T18 support)', () => {
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

  const title = async (name: string): Promise<string> =>
    (
      await testDb.sql.query<{ id: string }>(
        `INSERT INTO title (kind, status, title_romaji, episodes_total, fetched_at, detail_fetched_at)
         VALUES ('tv', 'finished', $1, 12, now(), now()) RETURNING id`,
        [name],
      )
    ).rows[0]!.id;
  const add = (titleId: string, status: string, as = auth) =>
    request(t.app).post('/v1/library').set('Authorization', as).send({ titleId, status });

  it('counts entries per status and favourites, ignoring removed ones and other users', async () => {
    const a = await add(await title('A'), 'watching');
    await add(await title('B'), 'watching');
    await add(await title('C'), 'completed');
    const removed = await add(await title('D'), 'planned');
    await request(t.app)
      .patch(`/v1/library/${a.body.data.id}`)
      .set('Authorization', auth)
      .send({ isFavorite: true });
    await request(t.app).delete(`/v1/library/${removed.body.data.id}`).set('Authorization', auth);
    const other = await t.signIn('other');
    await add(await title('E'), 'dropped', other.auth);

    const response = await t.get('/library/counts', auth);
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body.data).toEqual({
      watching: 2,
      completed: 1,
      planned: 0,
      on_hold: 0,
      dropped: 0,
      favorites: 1,
    });
    expect((await t.get('/library/counts', 'Bearer nope')).status).toBe(401);
  });

  it('is all zeros for a new library', async () => {
    expect((await t.get('/library/counts', auth)).body.data).toEqual({
      watching: 0,
      completed: 0,
      planned: 0,
      on_hold: 0,
      dropped: 0,
      favorites: 0,
    });
  });

  it("every title card carries the caller's own entry ID, so any screen can act on it", async () => {
    const id = await title('Show');
    const entry = (await add(id, 'watching')).body.data;
    const detail = await t.get(`/titles/${id}`, auth);
    expect(detail.body.data).toMatchObject({ libraryStatus: 'watching', libraryEntryId: entry.id });
    const other = await t.signIn('viewer');
    expect((await t.get(`/titles/${id}`, other.auth)).body.data).toMatchObject({
      libraryStatus: null,
      libraryEntryId: null,
    });
    expect((await t.get('/library', auth)).body.data[0].title.libraryEntryId).toBe(entry.id);
  });
});
