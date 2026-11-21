/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- supertest response bodies are untyped JSON; this suite reads them field by field */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildCatalogTestApp, type CatalogTestApp } from '../../testing/catalog.js';
import { createTestDatabase, type TestDatabase } from '../../testing/database.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NIL = '00000000-0000-4000-8000-000000000000';

interface Item {
  id: string;
  readAt: string | null;
  episode: { number: number };
  title: { titleRomaji: string };
}
const items = (response: request.Response): Item[] => (response.body as { data: Item[] }).data;

/** T23: the Inbox endpoints (doc 07 §5, FR-NOTE-003) on a real database. */
describe('inbox API (T23, FR-NOTE-003)', () => {
  let testDb: TestDatabase;
  let t: CatalogTestApp;
  let auth: string;
  let userId: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
  });
  afterAll(async () => {
    await testDb.drop();
  });
  beforeEach(async () => {
    await testDb.reset();
    t = await buildCatalogTestApp({ db: testDb.db.client });
    ({ auth, userId } = await t.signIn());
  });

  const sql = () => testDb.sql;
  const call = (method: 'get' | 'post' | 'delete', path: string, as = auth) =>
    request(t.app)[method](`/v1${path}`).set('Authorization', as);

  /** `n` notifications for `forUser`, oldest first (episode 1 is the oldest). */
  async function seed(
    n: number,
    forUser = userId,
    options: { adult?: boolean; name?: string } = {},
  ) {
    const title = (
      await sql().query<{ id: string }>(
        `INSERT INTO title (kind, status, title_romaji, is_adult, fetched_at)
         VALUES ('tv', 'releasing', $1, $2, now()) RETURNING id`,
        [options.name ?? 'Weekly Show', options.adult ?? false],
      )
    ).rows[0]!.id;
    const ids: string[] = [];
    for (let episode = 1; episode <= n; episode += 1) {
      const airs = new Date(Date.parse('2026-11-01T12:00:00Z') + episode * 86_400_000);
      const ep = (
        await sql().query<{ id: string }>(
          `INSERT INTO airing_episode (title_id, episode_number, airs_at, source, aired_processed_at)
           VALUES ($1, $2, $3, 'anilist', $3) RETURNING id`,
          [title, episode, airs],
        )
      ).rows[0]!.id;
      ids.push(
        (
          await sql().query<{ id: string }>(
            `INSERT INTO notification (user_id, kind, title_id, episode_id, created_at)
             VALUES ($1, 'episode_aired', $2, $3, $4) RETURNING id`,
            [forUser, title, ep, airs],
          )
        ).rows[0]!.id,
      );
    }
    return { title, ids };
  }

  describe('list and unread count', () => {
    it('lists newest first with the episode and a title card carrying the reader’s own status', async () => {
      const { title } = await seed(3);
      await request(t.app)
        .post('/v1/library')
        .set('Authorization', auth)
        .send({ titleId: title, status: 'watching' });
      const response = await call('get', '/inbox');
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.body.nextCursor).toBeNull();
      expect(items(response).map((item) => item.episode.number)).toEqual([3, 2, 1]);
      expect(response.body.data[0]).toEqual({
        id: expect.stringMatching(UUID),
        kind: 'episode_aired',
        createdAt: '2026-11-04T12:00:00.000Z',
        readAt: null,
        episode: { number: 3, airsAt: '2026-11-04T12:00:00.000Z' },
        title: expect.objectContaining({
          id: title,
          titleRomaji: 'Weekly Show',
          libraryStatus: 'watching',
          libraryEntryId: expect.stringMatching(UUID),
        }),
      });
    });

    it('pages with a cursor that keeps its size, never repeating or skipping an item', async () => {
      await seed(7);
      const first = await call('get', '/inbox?limit=3');
      expect(first.body.data).toHaveLength(3);
      expect(first.body.nextCursor).toEqual(expect.any(String));
      const second = await call('get', `/inbox?limit=3&cursor=${first.body.nextCursor}`);
      const third = await call('get', `/inbox?limit=3&cursor=${second.body.nextCursor}`);
      expect(third.body.nextCursor).toBeNull();
      const numbers = [first, second, third].flatMap((page) =>
        items(page).map((item) => item.episode.number),
      );
      expect(numbers).toEqual([7, 6, 5, 4, 3, 2, 1]);
      expect((await call('get', '/inbox?cursor=garbage')).status).toBe(422);
      expect((await call('get', '/inbox?limit=0')).status).toBe(422);
      expect((await call('get', '/inbox?limit=101')).status).toBe(422);
      expect((await call('get', '/inbox?unread=maybe')).status).toBe(422);
    });

    it('breaks ties between notifications made at the same instant by their ID', async () => {
      const { ids } = await seed(4);
      await sql().query(
        `UPDATE notification SET created_at = '2026-11-05T00:00:00Z' WHERE user_id = $1`,
        [userId],
      );
      const pages: string[] = [];
      let cursor: string | null = null;
      do {
        const page: request.Response = await call(
          'get',
          `/inbox?limit=1${cursor === null ? '' : `&cursor=${cursor}`}`,
        );
        pages.push(...items(page).map((item) => item.id));
        cursor = (page.body as { nextCursor: string | null }).nextCursor;
      } while (cursor !== null);
      expect(pages).toEqual([...ids].sort().reverse());
    });

    it('unread=true lists only what has not been read; the count follows', async () => {
      const { ids } = await seed(4);
      expect((await call('get', '/inbox/unread-count')).body).toEqual({ data: { count: 4 } });
      await call('post', `/inbox/${ids[0]}/read`);
      await call('post', `/inbox/${ids[1]}/read`);
      const unread = await call('get', '/inbox?unread=true');
      expect(items(unread).map((item) => item.episode.number)).toEqual([4, 3]);
      expect((await call('get', '/inbox/unread-count')).body).toEqual({ data: { count: 2 } });
      expect((await call('get', '/inbox?unread=false')).body.data).toHaveLength(4);
    });

    it('an empty inbox is an empty list and a zero count', async () => {
      expect((await call('get', '/inbox')).body).toEqual({ data: [], nextCursor: null });
      expect((await call('get', '/inbox/unread-count')).body).toEqual({ data: { count: 0 } });
    });
  });

  describe('mark read, mark all read, delete', () => {
    it('marks one as read, keeping the first time it was read when asked again', async () => {
      const { ids } = await seed(2);
      const first = await call('post', `/inbox/${ids[1]}/read`);
      expect(first.status).toBe(200);
      expect(first.body.data.id).toBe(ids[1]);
      const readAt = first.body.data.readAt as string;
      expect(readAt).toEqual(expect.any(String));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect((await call('post', `/inbox/${ids[1]}/read`)).body.data.readAt).toBe(readAt);
      // The other one is untouched.
      expect(
        items(await call('get', '/inbox')).find((item) => item.id === ids[0])?.readAt,
      ).toBeNull();
    });

    it('marks everything read, and says how many it changed', async () => {
      const { ids } = await seed(3);
      await call('post', `/inbox/${ids[0]}/read`);
      expect((await call('post', '/inbox/read-all')).body).toEqual({ data: { updated: 2 } });
      expect((await call('post', '/inbox/read-all')).body).toEqual({ data: { updated: 0 } });
      expect((await call('get', '/inbox/unread-count')).body.data.count).toBe(0);
      expect((await call('get', '/inbox')).body.data).toHaveLength(3); // read items stay
    });

    it('deletes one, for good', async () => {
      const { ids } = await seed(3);
      expect((await call('delete', `/inbox/${ids[1]}`)).status).toBe(204);
      expect(items(await call('get', '/inbox')).map((item) => item.id)).not.toContain(ids[1]);
      expect((await call('delete', `/inbox/${ids[1]}`)).status).toBe(404);
      expect((await call('get', '/inbox/unread-count')).body.data.count).toBe(2);
    });

    it('answers 404 for an unknown or malformed ID', async () => {
      for (const id of [NIL, 'nope']) {
        expect((await call('post', `/inbox/${id}/read`)).status).toBe(404);
        expect((await call('delete', `/inbox/${id}`)).status).toBe(404);
      }
    });
  });

  describe('privacy (doc 11 §3.2)', () => {
    it('another user gets 404 for your notification and changes nothing; their own inbox stays theirs', async () => {
      const { ids } = await seed(2);
      const other = await t.signIn('intruder');
      await seed(1, other.userId, { name: 'Their Show' });
      const before = JSON.stringify(
        (await sql().query('SELECT * FROM notification ORDER BY id')).rows,
      );

      expect((await call('post', `/inbox/${ids[0]}/read`, other.auth)).status).toBe(404);
      expect((await call('delete', `/inbox/${ids[0]}`, other.auth)).status).toBe(404);
      expect(
        JSON.stringify((await sql().query('SELECT * FROM notification ORDER BY id')).rows),
      ).toBe(before);

      const theirs = await call('get', '/inbox', other.auth);
      expect(theirs.body.data).toHaveLength(1);
      expect(JSON.stringify(theirs.body)).not.toContain('Weekly Show');
      expect((await call('get', '/inbox/unread-count', other.auth)).body.data.count).toBe(1);

      // Marking everything read touches only the caller's.
      await call('post', '/inbox/read-all', other.auth);
      expect((await call('get', '/inbox/unread-count')).body.data.count).toBe(2);
    });

    it('every route needs a signed-in user', async () => {
      for (const [method, path] of [
        ['get', '/inbox'],
        ['get', '/inbox/unread-count'],
        ['post', '/inbox/read-all'],
        ['post', `/inbox/${NIL}/read`],
        ['delete', `/inbox/${NIL}`],
      ] as const) {
        const response = await request(t.app)[method](`/v1${path}`);
        expect(response.status, `${method} ${path}`).toBe(401);
      }
    });

    it('leaves out adult-rated titles unless the user opted in (Q-10): list, count and actions', async () => {
      const { ids } = await seed(2, userId, { adult: true, name: 'Adult Show' });
      await seed(1, userId, { name: 'Plain Show' });
      expect(items(await call('get', '/inbox')).map((item) => item.title.titleRomaji)).toEqual([
        'Plain Show',
      ]);
      expect((await call('get', '/inbox/unread-count')).body.data.count).toBe(1);
      expect((await call('post', `/inbox/${ids[0]}/read`)).status).toBe(404);

      await request(t.app).patch('/v1/me').set('Authorization', auth).send({ showAdult: true });
      expect((await call('get', '/inbox')).body.data).toHaveLength(3);
      expect((await call('get', '/inbox/unread-count')).body.data.count).toBe(3);
      expect((await call('post', `/inbox/${ids[0]}/read`)).status).toBe(200);
    });
  });
});
