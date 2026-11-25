/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- supertest response bodies are untyped JSON; this suite reads them field by field */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildCatalogTestApp,
  recordedAniList,
  type CatalogTestApp,
} from '../../testing/catalog.js';
import { createTestDatabase, type TestDatabase } from '../../testing/database.js';
import { jsonResponse, type RecordedRequest } from '../../testing/sources.js';

/**
 * Seasons in one banner: a search page from AniList says how its titles relate, the links are
 * stored, and every title of the page then carries the franchise it belongs to.
 */

interface Edge {
  readonly relationType: string;
  readonly id: number;
}

const media = (
  id: number,
  english: string,
  year: number,
  edges: readonly Edge[],
  format = 'TV',
): Record<string, unknown> => ({
  id,
  idMal: null,
  title: { romaji: `Boku no ${english}`, english, native: null },
  synonyms: [],
  description: null,
  coverImage: { extraLarge: `https://img.example.test/${id}.jpg`, large: null, color: '#e4a128' },
  bannerImage: null,
  format,
  status: 'FINISHED',
  episodes: 13,
  duration: 24,
  season: 'SPRING',
  seasonYear: year,
  startDate: { year, month: 4, day: 3 },
  endDate: { year, month: 6, day: 26 },
  averageScore: 80,
  popularity: 1000 - (year - 2015),
  isAdult: false,
  genres: ['Action'],
  updatedAt: null,
  relations: {
    edges: edges.map((edge) => ({
      relationType: edge.relationType,
      node: {
        id: edge.id,
        idMal: null,
        type: 'ANIME',
        format: 'TV',
        title: { romaji: `Related ${edge.id}`, english: `Related ${edge.id} (en)` },
        coverImage: { large: `https://img.example.test/related-${edge.id}.jpg` },
      },
    })),
  },
});

/** Three seasons that point at each other (season 3 also at a season 4 that is not on the page), a movie off to the side, and a loner. */
const SEASONS = [
  media(1, 'My Hero Academia', 2016, [
    { relationType: 'SEQUEL', id: 2 },
    { relationType: 'SIDE_STORY', id: 5 },
  ]),
  media(2, 'My Hero Academia 2', 2017, [
    { relationType: 'PREQUEL', id: 1 },
    { relationType: 'SEQUEL', id: 3 },
  ]),
  media(3, 'My Hero Academia 3', 2018, [
    { relationType: 'PREQUEL', id: 2 },
    { relationType: 'SEQUEL', id: 4 },
  ]),
  media(5, 'My Hero Academia: The Movie', 2019, [{ relationType: 'SIDE_STORY', id: 1 }], 'MOVIE'),
  media(9, 'Some Other Show', 2018, []),
];

const page = (items: readonly Record<string, unknown>[]): Response =>
  jsonResponse(200, {
    data: { Page: { pageInfo: { currentPage: 1, hasNextPage: false }, media: items } },
  });

const searching = (request: RecordedRequest): Response | Promise<Response> =>
  ((request.body?.['query'] as string | undefined) ?? '').includes('query MediaPage')
    ? page(SEASONS)
    : recordedAniList(request);

describe('seasons under one franchise on a list page', () => {
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
    t = await buildCatalogTestApp({ db: testDb.db.client, anilist: searching });
    ({ auth } = await t.signIn());
  });

  const search = async () =>
    (await t.get('/titles/search?q=hero&limit=10', auth)).body.data as Array<{
      titleEnglish: string;
      franchise: null | { id: string; size: number; titleEnglish: string | null };
    }>;

  it('puts the seasons of one search page in one franchise, named after the first', async () => {
    const cards = await search();
    const seasons = cards.filter((card) => card.titleEnglish.startsWith('My Hero Academia'));
    expect(seasons).toHaveLength(4);
    const franchise = seasons[0]!.franchise;
    // Five titles, of which four are seasons: the movie hangs off the side, and season 4 is a
    // placeholder for the sequel of season 3 that is not on the page.
    expect(franchise).toMatchObject({ size: 5, seasons: 4, titleEnglish: 'My Hero Academia' });
    expect(new Set(seasons.map((card) => card.franchise?.id))).toEqual(new Set([franchise!.id]));
  });

  it('leaves a title with no relations out of any franchise', async () => {
    const loner = (await search()).find((card) => card.titleEnglish === 'Some Other Show');
    expect(loner?.franchise).toBeNull();
  });

  it('keeps a related season that is not on the page as a named placeholder, never fetched, and not listed', async () => {
    const cards = await search();
    expect(cards).toHaveLength(5);
    const titles = await testDb.sql.query<{
      title_romaji: string;
      title_english: string | null;
      cover_url: string | null;
      fetched_at: Date | null;
    }>(
      'SELECT title_romaji, title_english, cover_url, fetched_at FROM title ORDER BY title_romaji',
    );
    expect(titles.rows).toHaveLength(6);
    // The relation edge brings the placeholder its cover and English name, so a tile can show them.
    expect(titles.rows.find((row) => row.title_romaji === 'Related 4')).toMatchObject({
      fetched_at: null,
      title_english: 'Related 4 (en)',
      cover_url: 'https://img.example.test/related-4.jpg',
    });
  });

  it('puts a show seen alone on a page in its franchise at once, through its placeholders', async () => {
    t.anilist.responder = (request) =>
      ((request.body?.['query'] as string | undefined) ?? '').includes('query MediaPage')
        ? page([SEASONS[0]!])
        : recordedAniList(request);
    const [only] = await search();
    expect(only?.franchise).toMatchObject({ size: 3, titleEnglish: 'My Hero Academia' });
  });

  it('serves the whole franchise, oldest first, for the banner to open', async () => {
    const franchiseId = (await search())[0]!.franchise!.id;
    const response = await t.get(`/franchises/${franchiseId}`, auth);
    expect(response.status).toBe(200);
    expect(
      response.body.data.titles.map((title: { titleEnglish: string }) => title.titleEnglish),
    ).toEqual([
      'My Hero Academia',
      'My Hero Academia 2',
      'My Hero Academia 3',
      'My Hero Academia: The Movie',
      'Related 4 (en)',
    ]);
    expect(response.body.data.totals).toMatchObject({ titles: 5, inLibrary: 0 });
  });

  it('keeps the links when the same page is searched again', async () => {
    await search();
    const again = await search();
    expect(again.filter((card) => card.franchise !== null)).toHaveLength(4);
    const relations = await testDb.sql.query<{ n: string }>(
      'SELECT count(*) AS n FROM title_relation',
    );
    // 1->2, 2->1, 2->3, 3->2, 1->5, 5->1, and 3->4 to the placeholder for season 4.
    expect(Number(relations.rows[0]?.n)).toBe(7);
  });
});
