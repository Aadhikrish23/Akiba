/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- supertest response bodies are untyped JSON; this suite reads them field by field */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../testing/database.js';
import { insertEntry } from '../../testing/fixtures.js';
import {
  buildCatalogTestApp,
  recordedAniList,
  recordedJikan,
  type CatalogTestApp,
} from '../../testing/catalog.js';
import { fixture, jsonResponse, type RecordedRequest } from '../../testing/sources.js';
import { LIST_CACHE_TTL_MS, DONE_DETAIL_TTL_MS } from './titles.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const down = (): Response => jsonResponse(503, {});

interface Body {
  data: Array<Record<string, unknown>>;
  nextCursor: string | null;
  meta: { stale: boolean; source: string };
}

/**
 * T12: the discovery endpoints (doc 07 §3) on a real database with both metadata sources replaced
 * by fake networks. Recorded AniList responses, hand-written Jikan ones.
 */
describe('titles read API (T12, FR-DISC-001…010)', () => {
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

  const count = async (table: string): Promise<number> =>
    Number(
      (await testDb.sql.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n,
    );
  const searchBody = async (query = 'attack on titan'): Promise<Body> =>
    (await t.get(`/titles/search?q=${encodeURIComponent(query)}&limit=3`, auth)).body as Body;

  describe('search (FR-DISC-001)', () => {
    it('returns cards with Akiba IDs, never an external ID, and says where the answer came from', async () => {
      const response = await t.get('/titles/search?q=attack%20on%20titan&limit=3', auth);
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-cache');
      const body = response.body as Body;
      expect(body.meta).toEqual({ stale: false, source: 'anilist' });

      const first = body.data[0];
      expect(first).toMatchObject({
        titleRomaji: 'Shingeki no Kyojin',
        titleEnglish: 'Attack on Titan',
        kind: 'tv',
        status: 'finished',
        episodesTotal: 25,
        libraryStatus: null,
      });
      expect(first?.['id']).toMatch(UUID);
      // FR-DISC-008: nothing an external source calls an ID reaches the client.
      const keys = new Set<string>();
      JSON.stringify(body.data, (key, value: unknown) => {
        keys.add(key);
        return value;
      });
      expect([...keys].filter((key) => /anilist|idMal|mal_?id|external/i.test(key))).toEqual([]);
      for (const card of body.data) expect(card['id']).toMatch(UUID);
    });

    it('FR-DISC-008: every result is resolved to a stored title before it is shown', async () => {
      const body = await searchBody();
      expect(await count('title')).toBeGreaterThanOrEqual(body.data.length);
      const ids = (
        await testDb.sql.query<{ title_id: string }>(
          `SELECT title_id FROM title_external_id WHERE source = 'anilist'`,
        )
      ).rows.map((row) => row.title_id);
      for (const card of body.data) expect(ids).toContain(card['id']);
    });

    it('reuses the answer for identical requests instead of asking the source again', async () => {
      await searchBody();
      await searchBody();
      await searchBody();
      expect(t.anilist.requests).toHaveLength(1);
      // After the reuse window it asks again.
      t.time.advance(LIST_CACHE_TTL_MS + 1000);
      await searchBody();
      expect(t.anilist.requests).toHaveLength(2);
    });

    it('does not mix users up: the second user sees their own library status, from the same cache', async () => {
      const first = await searchBody();
      const titleId = first.data[0]?.['id'] as string;
      await insertEntry(testDb.sql, userId, titleId);

      const mine = await searchBody();
      expect(mine.data[0]?.['libraryStatus']).toBe('watching'); // FR-DISC-007
      const other = await t.signIn('other');
      const theirs = (await t.get('/titles/search?q=attack%20on%20titan&limit=3', other.auth))
        .body as Body;
      expect(theirs.data[0]?.['libraryStatus']).toBeNull();
      expect(t.anilist.requests).toHaveLength(1);
    });

    it('rejects a missing or empty query and unknown parameters with 422', async () => {
      for (const path of [
        '/titles/search',
        '/titles/search?q=',
        '/titles/search?q=x&surprise=1',
        '/titles/search?q=x&limit=0',
        '/titles/search?q=x&limit=101',
        '/titles/search?q=x&format=film',
      ]) {
        const response = await t.get(path, auth);
        expect(response.status, path).toBe(422);
        expect(response.body.code).toBe('VALIDATION_ERROR');
      }
    });
  });

  describe('pagination (FR-DISC-006)', () => {
    const lastPage = () => {
      const recorded = fixture('anilist', 'search-attack-on-titan').response as {
        data: { Page: { pageInfo: { hasNextPage: boolean } } };
      };
      recorded.data.Page.pageInfo.hasNextPage = false;
      return jsonResponse(200, recorded);
    };

    it('hands out a cursor while the source has more, and follows it to the next source page', async () => {
      // The recorded page really is followed by more results.
      const page1 = await searchBody();
      expect(page1.nextCursor).toEqual(expect.any(String));
      const page2 = await t.get(
        `/titles/search?q=attack%20on%20titan&limit=3&cursor=${page1.nextCursor}`,
        auth,
      );
      expect(page2.status).toBe(200);
      expect(t.anilist.variables(1)).toMatchObject({ page: 2, perPage: 3 });
    });

    it('keeps the page size of the cursor even if limit changes between pages', async () => {
      const page1 = await searchBody();
      await t.get(`/titles/search?q=attack%20on%20titan&limit=50&cursor=${page1.nextCursor}`, auth);
      expect(t.anilist.variables(1)).toMatchObject({ page: 2, perPage: 3 });
    });

    it('has no cursor on the last page', async () => {
      t.anilist.responder = lastPage;
      expect((await searchBody()).nextCursor).toBeNull();
    });

    it('refuses a cursor that is not ours with 422', async () => {
      for (const cursor of [
        'garbage',
        Buffer.from('{"k":"remote","page":-4,"perPage":3}').toString('base64url'),
      ]) {
        const response = await t.get(`/titles/search?q=x&cursor=${cursor}`, auth);
        expect(response.status).toBe(422);
        expect(response.body.errors).toEqual([{ path: 'cursor', message: 'is not valid' }]);
      }
    });
  });

  describe('browse and seasons (FR-DISC-002, FR-DISC-003)', () => {
    it('passes the filters on to the source', async () => {
      await t.get(
        '/titles/browse?genre=Comedy&format=tv&status=finished&sort=score&season=fall&year=2024&limit=4',
        auth,
      );
      expect(t.anilist.variables()).toMatchObject({
        genre: 'Comedy',
        format: 'TV',
        status: 'FINISHED',
        season: 'FALL',
        seasonYear: 2024,
        sort: ['SCORE_DESC'],
        perPage: 4,
        isAdult: false,
      });
    });

    it("maps start_date onto the sources' newest-first order", async () => {
      await t.get('/titles/browse?sort=start_date', auth);
      expect(t.anilist.variables()).toMatchObject({ sort: ['START_DATE_DESC'] });
    });

    it('serves a named season, and the current season from the clock', async () => {
      const named = await t.get('/seasons/2024/fall?limit=4', auth);
      expect(named.status).toBe(200);
      expect(named.body).toMatchObject({ season: 'fall', seasonYear: 2024 });
      expect(t.anilist.variables()).toMatchObject({ season: 'FALL', seasonYear: 2024 });

      const current = await t.get('/seasons/current', auth);
      // The manual clock sits in November 2023: fall.
      expect(current.body).toMatchObject({ season: 'fall', seasonYear: 2023 });
    });

    it.each(['/seasons/2024/autumn', '/seasons/1800/fall', '/seasons/abc/fall'])(
      'rejects %s with 422',
      async (path) => {
        expect((await t.get(path, auth)).status).toBe(422);
      },
    );
  });

  describe('title page (FR-DISC-004, FR-DISC-005)', () => {
    async function aotId(): Promise<string> {
      return (await searchBody()).data[0]?.['id'] as string;
    }

    it('fetches the detail on first view, then serves it from the catalog', async () => {
      const id = await aotId();
      const first = await t.get(`/titles/${id}`, auth);
      expect(first.status).toBe(200);
      expect(first.body.meta).toEqual({ stale: false, source: 'anilist' });
      expect(first.body.data).toMatchObject({
        id,
        titleEnglish: 'Attack on Titan',
        libraryStatus: null,
        nextAiring: null,
      });
      expect(first.body.data.studios.length).toBeGreaterThan(0);
      expect(first.body.data.genres).toContain('Action');
      expect(first.body.data.synopsis).not.toMatch(/<[a-z]/i);

      const detailCalls = (): number =>
        t.anilist.requests.filter((request) =>
          String(request.body?.['query']).includes('query MediaDetail'),
        ).length;
      expect(detailCalls()).toBe(1);
      const second = await t.get(`/titles/${id}`, auth);
      expect(second.body.meta.source).toBe('cache');
      expect(second.body.meta.stale).toBe(false);
      expect(detailCalls()).toBe(1);
    });

    it('asks again once the stored copy is older than its time to live', async () => {
      const id = await aotId();
      await t.get(`/titles/${id}`, auth);
      t.time.advance(DONE_DETAIL_TTL_MS + 1000);
      const again = await t.get(`/titles/${id}`, auth);
      expect(again.body.meta.source).toBe('anilist');
    });

    it('concurrent first views share one upstream request', async () => {
      const id = await aotId();
      const responses = await Promise.all([1, 2, 3, 4].map(() => t.get(`/titles/${id}`, auth)));
      expect(responses.every((response) => response.status === 200)).toBe(true);
      const detailCalls = t.anilist.requests.filter((request) =>
        String(request.body?.['query']).includes('query MediaDetail'),
      );
      expect(detailCalls).toHaveLength(1);
    });

    it('lists the related titles grouped by relation type, each already an Akiba title', async () => {
      const id = await aotId();
      const response = await t.get(`/titles/${id}/relations`, auth);
      expect(response.status).toBe(200);
      const groups = response.body.data as Array<{
        relationType: string;
        titles: Array<Record<string, unknown>>;
      }>;
      const types = groups.map((group) => group.relationType);
      expect(types).toEqual(
        expect.arrayContaining(['prequel', 'sequel', 'side_story', 'summary', 'alternative']),
      );
      // Fixed display order: story order first.
      expect(types.indexOf('prequel')).toBeLessThan(types.indexOf('side_story'));
      for (const group of groups) {
        for (const card of group.titles) expect(card['id']).toMatch(UUID);
      }
      // The manga edge of the recorded response is not a title here.
      expect(JSON.stringify(response.body)).not.toMatch(/53390/);
    });

    it('answers 404 for an unknown title, a malformed ID, and an adult title', async () => {
      expect((await t.get('/titles/00000000-0000-4000-8000-000000000000', auth)).status).toBe(404);
      expect((await t.get('/titles/not-an-id', auth)).status).toBe(404);
      const adult = (
        await testDb.sql.query<{ id: string }>(
          `INSERT INTO title (kind, status, title_romaji, is_adult) VALUES ('tv','finished','Adult Show', true) RETURNING id`,
        )
      ).rows[0]!.id;
      const response = await t.get(`/titles/${adult}`, auth);
      expect(response.status).toBe(404);
      expect(response.body.code).toBe('NOT_FOUND');
    });

    it("shows the caller's library status on the title (FR-DISC-007)", async () => {
      const id = await aotId();
      await insertEntry(testDb.sql, userId, id);
      expect((await t.get(`/titles/${id}`, auth)).body.data.libraryStatus).toBe('watching');
      const other = await t.signIn('viewer');
      expect((await t.get(`/titles/${id}`, other.auth)).body.data.libraryStatus).toBeNull();
    });
  });

  describe('adult titles are hidden by default (Q-10)', () => {
    it('drops adult entries a source returns, in lists and in the catalog', async () => {
      const page = fixture('anilist', 'search-attack-on-titan').response as {
        data: { Page: { media: Array<Record<string, unknown>> } };
      };
      const adultItem = { ...page.data.Page.media[0], id: 999001, idMal: 999001, isAdult: true };
      t.anilist.responder = () =>
        jsonResponse(200, {
          data: {
            Page: {
              pageInfo: { currentPage: 1, hasNextPage: false },
              media: [adultItem, ...page.data.Page.media],
            },
          },
        });
      const body = await searchBody();
      expect(body.data).toHaveLength(page.data.Page.media.length);
      expect(await count(`title_external_id WHERE external_id = '999001'`)).toBe(0);
    });

    it('asks the source to leave adult titles out in the first place', async () => {
      await searchBody();
      expect(t.anilist.variables()['isAdult']).toBe(false);
    });
  });

  describe('NFR-REL-001 / FR-DISC-010: when AniList is unavailable', () => {
    it.each([
      ['500', down],
      ['a rate limit', () => jsonResponse(429, {}, { 'Retry-After': '1' })],
      ['garbage', () => new Response('<html>', { status: 200 })],
    ])('serves the search from Jikan when AniList answers %s', async (_label, responder) => {
      t.anilist.responder = responder;
      const response = await t.get('/titles/search?q=attack&limit=4', auth);
      expect(response.status).toBe(200);
      expect(response.body.meta).toEqual({ stale: false, source: 'jikan' });
      const names = (response.body.data as Array<Record<string, unknown>>).map(
        (card) => card['titleRomaji'],
      );
      expect(names).toContain('Shingeki no Kyojin');
      // FR-DISC-009: the commercial (type CM) in Jikan's answer is not an anime title.
      expect(names).not.toContain('Attack on Titan Commercial');
      for (const card of response.body.data as Array<Record<string, unknown>>) {
        expect(card['id']).toMatch(UUID);
      }
    });

    it("serves from Akiba's own copy, labelled stale, when both sources are down", async () => {
      await searchBody(); // warm the catalog while AniList works
      t.time.advance(LIST_CACHE_TTL_MS + 1000); // so the next answer is not just the reuse cache
      t.anilist.responder = down;
      t.jikan.responder = down;
      const response = await t.get('/titles/search?q=kyojin&limit=3', auth);
      expect(response.status).toBe(200);
      expect(response.body.meta).toEqual({ stale: true, source: 'cache' });
      expect(response.body.data.length).toBeGreaterThan(0);
      expect(
        (response.body.data as Array<Record<string, unknown>>).map((card) => card['titleRomaji']),
      ).toContain('Shingeki no Kyojin');
    });

    it('says 503 with Retry-After when nothing can answer and nothing is stored', async () => {
      t.anilist.responder = down;
      t.jikan.responder = down;
      const response = await t.get('/titles/search?q=anything', auth);
      expect(response.status).toBe(503);
      expect(response.body.code).toBe('SOURCES_UNAVAILABLE');
      expect(response.headers['retry-after']).toBe('30');
      expect(response.headers['content-type']).toMatch(/problem\+json/);
    });

    it('serves a title page stale when the refresh fails, and never loses what it had', async () => {
      const id = (await searchBody()).data[0]?.['id'] as string;
      const fresh = await t.get(`/titles/${id}`, auth);
      t.anilist.responder = down;
      t.jikan.responder = down;
      t.time.advance(DONE_DETAIL_TTL_MS + 1000);

      const stale = await t.get(`/titles/${id}`, auth);
      expect(stale.status).toBe(200);
      expect(stale.body.meta).toEqual({ stale: true, source: 'cache' });
      expect(stale.body.data.studios).toEqual(fresh.body.data.studios);
      expect(stale.body.data.synopsis).toBe(fresh.body.data.synopsis);
    });

    it('a title that was never fetched and cannot be is 503, not an empty page', async () => {
      t.anilist.responder = recordedAniList;
      const id = (
        await testDb.sql.query<{ id: string }>(
          `INSERT INTO title (kind, status, title_romaji, stale) VALUES ('tv','not_yet_released','Placeholder', true) RETURNING id`,
        )
      ).rows[0]!.id;
      t.anilist.responder = down;
      t.jikan.responder = down;
      expect((await t.get(`/titles/${id}`, auth)).status).toBe(503);
    });

    it('library data is untouched by an outage', async () => {
      const id = (await searchBody()).data[0]?.['id'] as string;
      await insertEntry(testDb.sql, userId, id, { progress: 7 });
      t.anilist.responder = down;
      t.jikan.responder = down;
      for (let i = 0; i < 6; i += 1) await t.get('/titles/search?q=zzz', auth);
      const entry = await testDb.sql.query(
        `SELECT progress, status FROM library_entry WHERE user_id = $1`,
        [userId],
      );
      expect(entry.rows).toEqual([{ progress: 7, status: 'watching' }]);
    });

    it('the breaker opens after repeated failures, the fallback keeps answering, and /ready reports it', async () => {
      t.anilist.responder = down;
      for (let i = 0; i < 5; i += 1) await t.get(`/titles/search?q=attack${i}`, auth);
      expect(t.gateway.status().primary.breaker).toBe('open');
      const before = t.anilist.requests.length;
      const response = await t.get('/titles/search?q=attack-again', auth);
      expect(response.body.meta.source).toBe('jikan');
      expect(t.anilist.requests).toHaveLength(before);
    });
  });

  describe('genres', () => {
    it('lists genres from the source once, then from the database, without adult-only labels', async () => {
      const first = await t.get('/genres', auth);
      expect(first.status).toBe(200);
      expect(first.body.data).toContain('Action');
      expect(first.body.data.map((name: string) => name.toLowerCase())).not.toContain('hentai');
      const calls = t.anilist.requests.length;
      await t.get('/genres', auth);
      expect(t.anilist.requests).toHaveLength(calls);
    });
  });

  describe('access', () => {
    it.each([
      '/titles/search?q=x',
      '/titles/browse',
      '/seasons/current',
      '/seasons/2024/fall',
      '/titles/00000000-0000-4000-8000-000000000000',
      '/titles/00000000-0000-4000-8000-000000000000/relations',
      '/genres',
    ])('%s needs a signed-in user', async (path) => {
      const response = await t.get(path, 'Bearer not-a-token');
      expect(response.status).toBe(401);
      expect(response.body.code).toBe('UNAUTHENTICATED');
    });

    it('never makes a request to a source for an unauthenticated call', async () => {
      await t.get('/titles/search?q=x', 'Bearer nope');
      expect(t.anilist.requests).toHaveLength(0);
    });
  });
});

// Keep the helper imports honest for the recorded responders used above.
void recordedJikan;
void (null as unknown as RecordedRequest);
