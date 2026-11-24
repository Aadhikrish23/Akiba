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
        title: { romaji: `Related ${edge.id}` },
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
    // Four titles, of which three are seasons: the movie hangs off the side.
    expect(franchise).toMatchObject({ size: 4, seasons: 3, titleEnglish: 'My Hero Academia' });
    expect(new Set(seasons.map((card) => card.franchise?.id))).toEqual(new Set([franchise!.id]));
  });

  it('leaves a title with no relations out of any franchise', async () => {
    const loner = (await search()).find((card) => card.titleEnglish === 'Some Other Show');
    expect(loner?.franchise).toBeNull();
  });

  it('does not invent titles for relations whose other end is not on the page', async () => {
    await search();
    const titles = await testDb.sql.query<{ n: string }>('SELECT count(*) AS n FROM title');
    expect(Number(titles.rows[0]?.n)).toBe(5);
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
    ]);
    expect(response.body.data.totals).toMatchObject({ titles: 4, inLibrary: 0 });
  });

  it('keeps the links when the same page is searched again', async () => {
    await search();
    const again = await search();
    expect(again.filter((card) => card.franchise !== null)).toHaveLength(4);
    const relations = await testDb.sql.query<{ n: string }>(
      'SELECT count(*) AS n FROM title_relation',
    );
    // 1->2, 2->1, 2->3, 3->2, 1->5, 5->1: the link to the season that is not on the page is not stored.
    expect(Number(relations.rows[0]?.n)).toBe(6);
  });
});
