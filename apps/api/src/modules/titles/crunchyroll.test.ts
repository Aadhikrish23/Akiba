/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- supertest response bodies are untyped JSON; this suite reads them field by field */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildCatalogTestApp,
  recordedAniList,
  type CatalogTestApp,
} from '../../testing/catalog.js';
import { createTestDatabase, type TestDatabase } from '../../testing/database.js';
import { jsonResponse, type RecordedRequest } from '../../testing/sources.js';

/** Where to watch: the Crunchyroll series page on every card, and the episode pages AniList lists. */

const LINKS = [
  { site: 'Official Site', url: 'https://one-piece.com/', type: 'INFO' },
  { site: 'Crunchyroll', url: 'http://www.crunchyroll.com/one-piece', type: 'STREAMING' },
  { site: 'Hulu', url: 'http://www.hulu.com/one-piece', type: 'STREAMING' },
];

const media = (id: number, name: string, externalLinks: unknown[]) => ({
  id,
  idMal: null,
  title: { romaji: name, english: name, native: null },
  synonyms: [],
  description: null,
  coverImage: { extraLarge: null, large: null, color: null },
  bannerImage: null,
  externalLinks,
  format: 'TV',
  status: 'RELEASING',
  episodes: null,
  duration: 24,
  season: 'FALL',
  seasonYear: 1999,
  startDate: { year: 1999, month: 10, day: 20 },
  endDate: null,
  averageScore: 87,
  popularity: 1000,
  isAdult: false,
  genres: ['Action'],
  updatedAt: null,
  relations: { edges: [] },
});

const STREAMING = [
  {
    title: 'Episode 130 - Scent of Danger!',
    url: 'http://www.crunchyroll.com/watch/G8WUNGWKG/a',
    site: 'Crunchyroll',
  },
  {
    title: 'Episode 129 - It All Started On That Day!',
    url: 'http://www.crunchyroll.com/watch/GPWUKZ53G/b',
    site: 'Crunchyroll',
  },
  {
    title: 'Episode 129 - a duplicate is ignored',
    url: 'http://www.crunchyroll.com/watch/DUP/c',
    site: 'Crunchyroll',
  },
  { title: 'Episode 5 - on another service', url: 'https://www.hulu.com/watch/x', site: 'Hulu' },
  {
    title: 'Special - not an episode',
    url: 'http://www.crunchyroll.com/watch/SPECIAL/d',
    site: 'Crunchyroll',
  },
];

const answering = (request: RecordedRequest): Response | Promise<Response> => {
  const query = (request.body?.['query'] as string | undefined) ?? '';
  if (query.includes('query MediaPage')) {
    return jsonResponse(200, {
      data: {
        Page: {
          pageInfo: { currentPage: 1, hasNextPage: false },
          media: [media(21, 'One Piece', LINKS), media(22, 'Unlisted Show', [])],
        },
      },
    });
  }
  if (query.includes('query MediaDetail')) {
    const onePiece = (request.body?.['variables'] as { id?: number } | undefined)?.id === 21;
    return jsonResponse(200, {
      data: {
        Media: {
          ...(onePiece ? media(21, 'One Piece', LINKS) : media(22, 'Unlisted Show', [])),
          studios: { edges: [] },
          nextAiringEpisode: null,
          streamingEpisodes: onePiece ? STREAMING : [],
          characters: { edges: [] },
        },
      },
    });
  }
  return recordedAniList(request);
};

describe('Crunchyroll links', () => {
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
    t = await buildCatalogTestApp({ db: testDb.db.client, anilist: answering });
    ({ auth } = await t.signIn());
  });

  const search = async () =>
    (await t.get('/titles/search?q=one&limit=10', auth)).body.data as Array<{
      id: string;
      titleRomaji: string;
      crunchyrollUrl: string | null;
      streamingLinks: { site: string; url: string }[];
    }>;

  it('puts the Crunchyroll series page on a card, as https, and nothing for a show without one', async () => {
    const cards = await search();
    expect(cards.find((card) => card.titleRomaji === 'One Piece')?.crunchyrollUrl).toBe(
      'https://www.crunchyroll.com/one-piece',
    );
    expect(cards.find((card) => card.titleRomaji === 'Unlisted Show')?.crunchyrollUrl).toBeNull();
  });

  it('lists every service that streams the show, Crunchyroll first, and leaves out its official site', async () => {
    const cards = await search();
    expect(cards.find((card) => card.titleRomaji === 'One Piece')?.streamingLinks).toEqual([
      { site: 'Crunchyroll', url: 'https://www.crunchyroll.com/one-piece' },
      { site: 'Hulu', url: 'https://www.hulu.com/one-piece' },
    ]);
    expect(cards.find((card) => card.titleRomaji === 'Unlisted Show')?.streamingLinks).toEqual([]);
  });

  it('keeps the episode pages AniList lists, by number, only Crunchyroll ones that are episodes', async () => {
    const id = (await search()).find((card) => card.titleRomaji === 'One Piece')!.id;
    const detail = (await t.get(`/titles/${id}`, auth)).body.data;
    expect(detail.crunchyrollEpisodes).toEqual({
      '129': 'https://www.crunchyroll.com/watch/GPWUKZ53G/b',
      '130': 'https://www.crunchyroll.com/watch/G8WUNGWKG/a',
    });
    expect(detail.crunchyrollUrl).toBe('https://www.crunchyroll.com/one-piece');
  });

  it('fetches the detail of a title stored before episode links were kept, once, to get them', async () => {
    const id = (await search()).find((card) => card.titleRomaji === 'One Piece')!.id;
    await t.get(`/titles/${id}`, auth); // detail fetched: links stored
    // As it was before this feature: detail fresh, links never fetched.
    await testDb.sql.query(
      'UPDATE title SET crunchyroll_episodes = NULL, detail_fetched_at = now() WHERE id = $1',
      [id],
    );
    const detailRequests = () =>
      t.anilist.requests.filter((request) =>
        String(request.body?.['query']).includes('query MediaDetail'),
      ).length;
    const before = detailRequests();

    const first = (await t.get(`/titles/${id}`, auth)).body.data;
    expect(detailRequests()).toBe(before + 1);
    expect(Object.keys(first.crunchyrollEpisodes)).toEqual(['129', '130']);

    await t.get(`/titles/${id}`, auth);
    expect(detailRequests()).toBe(before + 1); // not again: the links are known now
  });

  it('drops episode pages numbered past the season, as AniList lists a whole show under each season', async () => {
    const wholeShow = [139, 140, 159].map((n) => ({
      title: `Episode ${n} - somewhere in the show`,
      url: `http://www.crunchyroll.com/watch/ABS${n}/x`,
      site: 'Crunchyroll',
    }));
    const app = await buildCatalogTestApp({
      db: testDb.db.client,
      anilist: (request) => {
        const query = (request.body?.['query'] as string | undefined) ?? '';
        const season = { ...media(31, 'Season One', LINKS), episodes: 13 };
        if (query.includes('query MediaPage')) {
          return jsonResponse(200, {
            data: { Page: { pageInfo: { currentPage: 1, hasNextPage: false }, media: [season] } },
          });
        }
        if (query.includes('query MediaDetail')) {
          return jsonResponse(200, {
            data: {
              Media: {
                ...season,
                studios: { edges: [] },
                nextAiringEpisode: null,
                streamingEpisodes: [
                  ...wholeShow,
                  STREAMING[0],
                  {
                    ...STREAMING[0],
                    title: 'Episode 3 - this one is ours',
                    url: 'http://www.crunchyroll.com/watch/OWN3/y',
                  },
                ],
                characters: { edges: [] },
              },
            },
          });
        }
        return recordedAniList(request);
      },
    });
    const { auth: own } = await app.signIn('own');
    const found = (await app.get('/titles/search?q=season&limit=5', own)).body.data[0];
    const detail = (await app.get(`/titles/${found.id}`, own)).body.data;
    // 139, 140, 159 and 130 are past the 13 episodes; episode 3 is the season's own.
    expect(detail.crunchyrollEpisodes).toEqual({
      '3': 'https://www.crunchyroll.com/watch/OWN3/y',
    });
  });

  it('a title that was never opened has no episode pages, only the series link', async () => {
    const id = (await search()).find((card) => card.titleRomaji === 'Unlisted Show')!.id;
    const detail = (await t.get(`/titles/${id}`, auth)).body.data;
    expect(detail.crunchyrollEpisodes).toEqual({});
  });
});
