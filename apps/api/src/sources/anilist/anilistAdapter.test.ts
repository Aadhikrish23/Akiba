import { describe, expect, it } from 'vitest';
import {
  FakeNet,
  ManualTime,
  fixture,
  fixtureResponse,
  jsonResponse,
} from '../../testing/sources.js';
import { SourceError } from '../types.js';
import { createAniListAdapter } from './anilistAdapter.js';

function adapterFor(net: FakeNet, extra: Parameters<typeof createAniListAdapter>[0] = {}) {
  const time = new ManualTime();
  return createAniListAdapter({
    fetch: net.fetch,
    now: time.now,
    sleep: time.sleep,
    random: () => 0,
    requestsPerMinute: 6000,
    ...extra,
  });
}

const serving = (name: string) => new FakeNet(() => fixtureResponse(fixture('anilist', name)));
const PAGE_1 = { page: 1, perPage: 3 };

describe('AniList adapter: contract against recorded responses (NFR-MNT-003)', () => {
  it('FR-DISC-001: search returns normalised titles with AniList and MAL IDs', async () => {
    const net = serving('search-attack-on-titan');
    const page = await adapterFor(net).search('attack on titan', {}, PAGE_1);

    expect(page.items.length).toBeGreaterThan(0);
    expect(page.page).toBe(1);
    const first = page.items[0];
    expect(first).toMatchObject({
      source: 'anilist',
      kind: 'tv',
      titleRomaji: 'Shingeki no Kyojin',
      titleEnglish: 'Attack on Titan',
      titleNative: '進撃の巨人',
      status: 'finished',
      episodesTotal: 25,
      season: 'spring',
      seasonYear: 2013,
      isAdult: false,
    });
    expect(first?.externalIds).toEqual({ anilist: '16498', mal: '16498' });
    expect(first?.coverUrl).toMatch(/^https:\/\//);
    expect(first?.startDate).toEqual({ year: 2013, month: 4, day: 7 });
    expect(first?.averageScore).toBeGreaterThan(0);
    expect(first?.genres).toContain('Action');
  });

  it('turns the synopsis into plain text (no markup reaches the catalog)', async () => {
    const page = await adapterFor(serving('search-attack-on-titan')).search('x', {}, PAGE_1);
    for (const title of page.items) {
      expect(title.synopsis ?? '').not.toMatch(/<[a-z/][^>]*>/i);
      expect(title.synopsis ?? '').not.toMatch(/&(?:amp|lt|gt|quot);/);
    }
  });

  it('FR-DISC-002: browse by season sends season, year and a popularity sort', async () => {
    const net = serving('browse-fall-2024');
    const page = await adapterFor(net).browse(
      { season: 'fall', seasonYear: 2024 },
      { page: 1, perPage: 4 },
    );
    expect(net.variables()).toMatchObject({
      season: 'FALL',
      seasonYear: 2024,
      sort: ['POPULARITY_DESC'],
      page: 1,
      perPage: 4,
    });
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((title) => title.seasonYear === 2024 && title.season === 'fall')).toBe(
      true,
    );
  });

  it('Q-10: adult titles are excluded unless asked for', async () => {
    const hidden = serving('browse-fall-2024');
    await adapterFor(hidden).browse({}, PAGE_1);
    expect(hidden.variables()['isAdult']).toBe(false);

    const shown = serving('browse-fall-2024');
    await adapterFor(shown).browse({ includeAdult: true }, PAGE_1);
    expect('isAdult' in shown.variables() && shown.variables()['isAdult'] !== undefined).toBe(
      false,
    );
  });

  it('maps filters onto AniList enums', async () => {
    const net = serving('browse-fall-2024');
    await adapterFor(net).browse(
      { kind: 'tv_short', status: 'not_yet_released', genre: 'Comedy', sort: 'score' },
      PAGE_1,
    );
    expect(net.variables()).toMatchObject({
      format: 'TV_SHORT',
      status: 'NOT_YET_RELEASED',
      genre: 'Comedy',
      sort: ['SCORE_DESC'],
    });
  });

  it('searches by relevance unless a sort is given, and clamps perPage to 50', async () => {
    const net = serving('search-attack-on-titan');
    await adapterFor(net).search('x', {}, { page: 2, perPage: 500 });
    expect(net.variables()).toMatchObject({ sort: ['SEARCH_MATCH'], page: 2, perPage: 50 });
  });

  it('FR-DISC-004: detail carries studios, relations (anime only) and no manga adaptation', async () => {
    const net = serving('detail-16498');
    const detail = await adapterFor(net).getTitle('16498');
    expect(detail).not.toBeNull();
    expect(detail?.studios.length).toBeGreaterThan(0);
    expect(detail?.studios.some((studio) => studio.isMain)).toBe(true);

    const types = new Set(detail?.relations.map((relation) => relation.relationType));
    expect(types).toContain('sequel');
    expect(types).toContain('prequel');
    expect(types).toContain('side_story');
    expect(types).toContain('summary');
    expect(types).toContain('alternative');
    // The recorded SOURCE:MANGA edge must not appear: manga are not titles in Akiba.
    expect(
      detail?.relations.every((relation) => relation.target.externalIds.anilist !== '53390'),
    ).toBe(true);
    expect(detail?.relations[0]?.target.externalIds.anilist).toMatch(/^\d+$/);
  });

  it('FR-DISC-004: getRelations returns the same relations as the detail', async () => {
    const detail = await adapterFor(serving('detail-16498')).getTitle('16498');
    const relations = await adapterFor(serving('detail-16498')).getRelations('16498');
    expect(relations).toEqual(detail?.relations);
  });

  it('NFR-REL-001: a title AniList does not have is null, not an error', async () => {
    const net = serving('detail-not-found');
    await expect(adapterFor(net).getTitle('999999999')).resolves.toBeNull();
  });

  it('does not ask AniList for an ID that cannot be one', async () => {
    const net = serving('detail-16498');
    const adapter = adapterFor(net);
    await expect(adapter.getTitle('not-a-number')).resolves.toBeNull();
    await expect(adapter.getTitle('-4')).resolves.toBeNull();
    expect(net.requests).toHaveLength(0);
  });

  it('FR-NOTE-001: airing returns one entry per scheduled episode with real dates', async () => {
    const net = serving('airing-next-week');
    const from = new Date('2026-11-18T00:00:00Z');
    const slots = await adapterFor(net).getAiring(
      ['195516', '195604', 'junk'],
      from,
      new Date('2026-11-25T00:00:00Z'),
    );
    expect(slots.length).toBeGreaterThan(0);
    expect(slots[0]).toMatchObject({ externalId: '195516', episode: 8 });
    expect(slots[0]?.airsAt).toBeInstanceOf(Date);
    // Seconds on the wire, a Date in the app; junk IDs are not sent.
    expect(net.variables()['ids']).toEqual([195516, 195604]);
    expect(net.variables()['from']).toBe(Math.floor(from.getTime() / 1000));
  });

  it('asks for nothing when there is nothing to ask', async () => {
    const net = serving('airing-next-week');
    await expect(adapterFor(net).getAiring([], new Date(), new Date())).resolves.toEqual([]);
    expect(net.requests).toHaveLength(0);
  });

  it('FR-DISC-006: lists the genres', async () => {
    const genres = await adapterFor(serving('genres')).getGenres();
    expect(genres).toContain('Action');
    expect(genres.every((genre) => typeof genre === 'string')).toBe(true);
  });

  it('declares airing support and a closed breaker at the start', () => {
    const adapter = adapterFor(serving('genres'));
    expect(adapter.name).toBe('anilist');
    expect(adapter.capabilities.airing).toBe(true);
    expect(adapter.breakerState()).toBe('closed');
  });

  it('posts to the configured endpoint with a JSON GraphQL body', async () => {
    const net = serving('genres');
    await adapterFor(net, { url: 'https://anilist.example.test/graphql' }).getGenres();
    expect(net.requests[0]).toMatchObject({
      url: 'https://anilist.example.test/graphql',
      method: 'POST',
    });
    expect(typeof net.requests[0]?.body?.['query']).toBe('string');
  });
});

describe('AniList adapter: normalisation edge cases', () => {
  const media = (overrides: Record<string, unknown>) => ({
    data: {
      Page: {
        pageInfo: { currentPage: 1, hasNextPage: false },
        media: [{ id: 1, title: { romaji: 'R' }, status: 'FINISHED', format: 'TV', ...overrides }],
      },
    },
  });
  const normalised = async (overrides: Record<string, unknown>) => {
    const net = new FakeNet(() => jsonResponse(200, media(overrides)));
    return (await adapterFor(net).browse({}, PAGE_1)).items[0];
  };

  it('keeps partial dates as they are (an announcement may know only the year)', async () => {
    const title = await normalised({
      startDate: { year: 2027, month: null, day: null },
      endDate: {},
    });
    expect(title?.startDate).toEqual({ year: 2027, month: null, day: null });
    expect(title?.endDate).toBeNull();
  });

  it('tolerates a title with almost nothing known', async () => {
    const title = await normalised({
      format: null,
      status: null,
      episodes: null,
      description: null,
      coverImage: null,
      genres: null,
      synonyms: null,
      averageScore: null,
    });
    expect(title).toMatchObject({
      kind: 'tv',
      format: null,
      status: 'not_yet_released',
      episodesTotal: null,
      synopsis: null,
      coverUrl: null,
      genres: [],
      synonyms: [],
      averageScore: null,
      externalIds: { anilist: '1' },
    });
  });

  it.each([
    ['TV', 'tv'],
    ['TV_SHORT', 'tv_short'],
    ['MOVIE', 'movie'],
    ['SPECIAL', 'special'],
    ['OVA', 'ova'],
    ['ONA', 'ona'],
    ['MUSIC', 'music'],
  ] as const)('maps format %s to kind %s', async (format, kind) => {
    expect((await normalised({ format }))?.kind).toBe(kind);
  });

  it.each([
    ['FINISHED', 'finished'],
    ['RELEASING', 'releasing'],
    ['NOT_YET_RELEASED', 'not_yet_released'],
    ['CANCELLED', 'cancelled'],
    ['HIATUS', 'hiatus'],
  ] as const)('maps status %s to %s', async (status, expected) => {
    expect((await normalised({ status }))?.status).toBe(expected);
  });

  it('refuses a cover URL that is not http(s) (clients render it)', async () => {
    const title = await normalised({
      coverImage: { extraLarge: 'javascript:alert(1)', large: 'https://img.example.test/a.jpg' },
    });
    expect(title?.coverUrl).toBe('https://img.example.test/a.jpg');
  });

  it('strips markup and entities from the synopsis', async () => {
    const title = await normalised({ description: 'One<br><br>Two &amp; <i>three</i> &lt;b&gt;' });
    expect(title?.synopsis).toBe('One\n\nTwo & three <b>');
  });
});

describe('AniList adapter: failures (NFR-REL-001)', () => {
  const failing = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
    new FakeNet(() => jsonResponse(status, body, headers));

  it('rate limited → rate_limited with Retry-After, after 3 attempts', async () => {
    const net = failing(429, {}, { 'Retry-After': '1' });
    await expect(adapterFor(net).getGenres()).rejects.toMatchObject({
      kind: 'rate_limited',
      retryAfterMs: 1000,
    });
    expect(net.requests).toHaveLength(3);
  });

  it('server error → unavailable', async () => {
    await expect(adapterFor(failing(502)).getGenres()).rejects.toMatchObject({
      kind: 'unavailable',
    });
  });

  it('GraphQL errors → bad_response (not retried)', async () => {
    const net = failing(400, {
      errors: [{ message: 'Validation error', status: 400 }],
      data: null,
    });
    await expect(adapterFor(net).getGenres()).rejects.toMatchObject({ kind: 'bad_response' });
    expect(net.requests).toHaveLength(1);
  });

  it('an API change (wrong shape) → bad_response, not garbage in the catalog', async () => {
    const net = failing(200, { data: { Page: { pageInfo: {}, media: [{ id: 'not-a-number' }] } } });
    await expect(adapterFor(net).browse({}, PAGE_1)).rejects.toBeInstanceOf(SourceError);
    await expect(adapterFor(net).browse({}, PAGE_1)).rejects.toMatchObject({
      kind: 'bad_response',
    });
  });

  it('coalesces identical concurrent searches into one request', async () => {
    const net = serving('search-attack-on-titan');
    const adapter = adapterFor(net);
    await Promise.all([
      adapter.search('attack', {}, PAGE_1),
      adapter.search('attack', {}, PAGE_1),
      adapter.search('attack', {}, PAGE_1),
    ]);
    expect(net.requests).toHaveLength(1);
  });

  it('opens its breaker after 5 failed operations', async () => {
    const net = failing(503);
    const adapter = adapterFor(net);
    for (let i = 0; i < 5; i += 1) await adapter.getGenres().catch(() => undefined);
    expect(adapter.breakerState()).toBe('open');
    const before = net.requests.length;
    await expect(adapter.getGenres()).rejects.toMatchObject({ kind: 'circuit_open' });
    expect(net.requests).toHaveLength(before);
  });
});
