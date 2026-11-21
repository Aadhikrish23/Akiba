import { describe, expect, it } from 'vitest';
import {
  FakeNet,
  ManualTime,
  fixture,
  fixtureResponse,
  jsonResponse,
  type RecordedRequest,
} from '../../testing/sources.js';
import { createJikanAdapter, parseDurationMinutes } from './jikanAdapter.js';

/** Serves fixtures by URL path. The fixtures are hand-written (see fixtures/jikan/README.md). */
function routed(routes: Record<string, string>): FakeNet {
  return new FakeNet((request: RecordedRequest) => {
    const path = new URL(request.url).pathname.replace(/^\/v4/, '');
    const name = routes[path];
    if (name === undefined) return jsonResponse(404, { status: 404, type: 'BadResponseException' });
    return fixtureResponse(fixture('jikan', name));
  });
}

function adapterFor(net: FakeNet) {
  const time = new ManualTime();
  return createJikanAdapter({
    url: 'https://jikan.example.test/v4',
    fetch: net.fetch,
    now: time.now,
    sleep: time.sleep,
    random: () => 0,
    requestsPerMinute: 6000,
  });
}

const PAGE_1 = { page: 1, perPage: 4 };
const queryOf = (net: FakeNet, index = 0): URLSearchParams =>
  new URL(net.requests[index]?.url ?? 'https://x.test/').searchParams;

describe('Jikan adapter: contract against the documented v4 schema (fallback source, Q-01)', () => {
  it('FR-DISC-001: search returns MAL-ID titles in the Akiba vocabulary', async () => {
    const net = routed({ '/anime': 'search-attack' });
    const page = await adapterFor(net).search('attack', {}, PAGE_1);

    const first = page.items[0];
    expect(first).toMatchObject({
      source: 'jikan',
      kind: 'tv',
      titleRomaji: 'Shingeki no Kyojin',
      titleEnglish: 'Attack on Titan',
      titleNative: '進撃の巨人',
      status: 'finished',
      episodesTotal: 25,
      durationMin: 24,
      season: 'spring',
      seasonYear: 2013,
      averageScore: 86, // 8.57 on MAL's 0–10 scale
      isAdult: false,
      synonyms: ['AoT', 'SnK'],
    });
    expect(first?.externalIds).toEqual({ mal: '16498' });
    expect(first?.startDate).toEqual({ year: 2013, month: 4, day: 7 });
    expect(first?.coverUrl).toBe('https://cdn.myanimelist.net/images/anime/10/47347l.jpg');
    expect(page.hasNextPage).toBe(true);
    expect(page.page).toBe(1);
  });

  it('excludes records that are not anime titles (commercials, promo videos)', async () => {
    const page = await adapterFor(routed({ '/anime': 'search-attack' })).search(
      'attack',
      {},
      PAGE_1,
    );
    expect(page.items.map((title) => title.externalIds.mal)).not.toContain('99999');
  });

  it('Q-10: flags adult titles (Rx rating, Hentai genre) and asks for sfw results by default', async () => {
    const net = routed({ '/anime': 'search-attack' });
    const page = await adapterFor(net).search('attack', {}, PAGE_1);
    expect(page.items.find((title) => title.externalIds.mal === '12345')?.isAdult).toBe(true);
    expect(queryOf(net).get('sfw')).toBe('true');

    const open = routed({ '/anime': 'search-attack' });
    await adapterFor(open).search('attack', { includeAdult: true }, PAGE_1);
    expect(queryOf(open).has('sfw')).toBe(false);
  });

  it('parses "1 hr 5 min" style durations', () => {
    expect(parseDurationMinutes('24 min per ep')).toBe(24);
    expect(parseDurationMinutes('1 hr 55 min')).toBe(115);
    expect(parseDurationMinutes('2 hr')).toBe(120);
    expect(parseDurationMinutes('Unknown')).toBeNull();
    expect(parseDurationMinutes(null)).toBeNull();
  });

  it('sends the text query, paging, and caps limit at 25', async () => {
    const net = routed({ '/anime': 'search-attack' });
    await adapterFor(net).search('attack on titan', {}, { page: 3, perPage: 50 });
    const query = queryOf(net);
    expect(query.get('q')).toBe('attack on titan');
    expect(query.get('page')).toBe('3');
    expect(query.get('limit')).toBe('25');
    // Relevance order for a text search: no order_by unless a sort was asked for.
    expect(query.has('order_by')).toBe(false);
  });

  it('FR-DISC-002: browse by season uses the season endpoint', async () => {
    const net = routed({ '/seasons/2024/fall': 'season-fall-2024' });
    const page = await adapterFor(net).browse({ season: 'fall', seasonYear: 2024 }, PAGE_1);
    expect(net.requests[0]?.url).toContain('/seasons/2024/fall');
    expect(page.items[0]).toMatchObject({
      status: 'releasing',
      episodesTotal: null,
      season: 'fall',
    });
  });

  it('browse without a season is ordered by popularity (lower MAL rank first)', async () => {
    const net = routed({ '/anime': 'search-attack' });
    await adapterFor(net).browse({ sort: 'popularity', kind: 'ova', status: 'finished' }, PAGE_1);
    expect(Object.fromEntries(queryOf(net))).toMatchObject({
      order_by: 'popularity',
      sort: 'asc',
      type: 'ova',
      status: 'complete',
    });
  });

  it("FR-DISC-006: resolves a genre name to MAL's numeric genre ID, loading the list once", async () => {
    const net = routed({ '/genres/anime': 'genres', '/anime': 'search-attack' });
    const adapter = adapterFor(net);
    await adapter.browse({ genre: 'Comedy' }, PAGE_1);
    await adapter.browse({ genre: 'comedy' }, PAGE_1);
    const listings = net.requests.filter((request) => request.url.includes('/anime?'));
    expect(listings.map((request) => new URL(request.url).searchParams.get('genres'))).toEqual([
      '4',
      '4',
    ]);
    expect(net.requests.filter((request) => request.url.includes('/genres/anime'))).toHaveLength(1);
  });

  it('an unknown genre matches nothing, without calling the listing', async () => {
    const net = routed({ '/genres/anime': 'genres', '/anime': 'search-attack' });
    const page = await adapterFor(net).browse({ genre: 'Nonexistent' }, PAGE_1);
    expect(page.items).toEqual([]);
    expect(net.requests.every((request) => !request.url.includes('/anime?'))).toBe(true);
  });

  it('does not offer adult genres in the genre list', async () => {
    const genres = await adapterFor(routed({ '/genres/anime': 'genres' })).getGenres();
    expect(genres).toEqual(['Action', 'Comedy', 'Drama']);
  });

  it('FR-DISC-004: detail has studios and relations, with manga edges removed', async () => {
    const net = routed({ '/anime/16498/full': 'detail-16498' });
    const detail = await adapterFor(net).getTitle('16498');
    expect(detail?.studios).toEqual([
      { externalId: '858', name: 'Wit Studio', isAnimationStudio: true, isMain: true },
    ]);
    expect(
      detail?.relations.map((relation) => [relation.relationType, relation.target.externalIds.mal]),
    ).toEqual([
      ['sequel', '25777'],
      ['side_story', '18397'],
      ['summary', '25781'],
      ['other', '31000'],
    ]);
    expect(detail?.nextAiring).toBeNull();
    expect(detail?.synopsis).toContain('titans');
  });

  it('getRelations returns the relations of the detail', async () => {
    const net = routed({ '/anime/16498/full': 'detail-16498' });
    await expect(adapterFor(net).getRelations('16498')).resolves.toHaveLength(4);
  });

  it('NFR-REL-001: an unknown MAL ID is null, not an error', async () => {
    await expect(adapterFor(routed({})).getTitle('1')).resolves.toBeNull();
  });

  it('does not ask for an ID that cannot be one', async () => {
    const net = routed({});
    await expect(adapterFor(net).getTitle('abc')).resolves.toBeNull();
    expect(net.requests).toHaveLength(0);
  });

  it('cannot answer airing questions, and says so', async () => {
    const adapter = adapterFor(routed({}));
    expect(adapter.capabilities.airing).toBe(false);
    await expect(adapter.getAiring(['1'], new Date(), new Date())).rejects.toMatchObject({
      kind: 'unsupported',
    });
  });
});

describe('Jikan adapter: failures (NFR-REL-001)', () => {
  it('5xx → unavailable after 3 attempts; 429 keeps Retry-After', async () => {
    const down = new FakeNet(() => jsonResponse(503, {}));
    await expect(adapterFor(down).getGenres()).rejects.toMatchObject({ kind: 'unavailable' });
    expect(down.requests).toHaveLength(3);

    const limited = new FakeNet(() => jsonResponse(429, {}, { 'Retry-After': '2' }));
    await expect(adapterFor(limited).getGenres()).rejects.toMatchObject({
      kind: 'rate_limited',
      retryAfterMs: 2000,
    });
  });

  it('an API change (wrong shape) → bad_response', async () => {
    const net = new FakeNet(() => jsonResponse(200, { data: [{ mal_id: 'x' }] }));
    await expect(adapterFor(net).search('q', {}, PAGE_1)).rejects.toMatchObject({
      kind: 'bad_response',
    });
  });

  it('a 400 from MAL is bad_response and is not retried', async () => {
    const net = new FakeNet(() => jsonResponse(400, { status: 400 }));
    await expect(adapterFor(net).search('q', {}, PAGE_1)).rejects.toMatchObject({
      kind: 'bad_response',
    });
    expect(net.requests).toHaveLength(1);
  });
});
