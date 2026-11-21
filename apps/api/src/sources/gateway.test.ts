import { describe, expect, it } from 'vitest';
import {
  FakeNet,
  ManualTime,
  fixture,
  fixtureResponse,
  jsonResponse,
  type RecordedRequest,
} from '../testing/sources.js';
import { createAniListAdapter } from './anilist/anilistAdapter.js';
import { SourceGateway, SourcesUnavailableError } from './gateway.js';
import { createJikanAdapter } from './jikan/jikanAdapter.js';
import type { SourceError } from './types.js';

/**
 * Two fake networks (one per source) behind the real adapters and the real gateway. This is the
 * NFR-REL-001 scenario of doc 11 §6: AniList times out / 429s / 500s, the breaker opens, the
 * fallback answers, and "no such title" is never mistaken for an outage.
 */
function setup(options: { fallback?: boolean } = {}) {
  const time = new ManualTime();
  const anilistNet = new FakeNet((request: RecordedRequest) => {
    const query = (request.body?.['query'] as string | undefined) ?? '';
    if (query.includes('query MediaDetail'))
      return fixtureResponse(fixture('anilist', 'detail-16498'));
    return fixtureResponse(fixture('anilist', 'search-attack-on-titan'));
  });
  const jikanNet = new FakeNet((request: RecordedRequest) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith('/full')) return fixtureResponse(fixture('jikan', 'detail-16498'));
    return fixtureResponse(fixture('jikan', 'search-attack'));
  });
  const common = { now: time.now, sleep: time.sleep, random: () => 0, requestsPerMinute: 6000 };
  const primary = createAniListAdapter({ fetch: anilistNet.fetch, ...common });
  const fallback = createJikanAdapter({
    url: 'https://jikan.example.test/v4',
    fetch: jikanNet.fetch,
    ...common,
  });
  const fallbacks: string[] = [];
  const gateway = new SourceGateway({
    primary,
    ...(options.fallback === false ? {} : { fallback }),
    onFallback: ({ operation, primaryError }) =>
      fallbacks.push(`${operation}:${primaryError.kind}`),
  });
  return { gateway, anilistNet, jikanNet, time, fallbacks };
}

const PAGE = { page: 1, perPage: 3 };
const down =
  (status = 503): (() => Response) =>
  () =>
    jsonResponse(status, {});

describe('SourceGateway: the happy path', () => {
  it('answers from AniList and says so', async () => {
    const { gateway, jikanNet } = setup();
    const result = await gateway.search('attack', {}, PAGE);
    expect(result).toMatchObject({ source: 'anilist', viaFallback: false });
    expect(result.data.items[0]?.externalIds.anilist).toBe('16498');
    expect(jikanNet.requests).toHaveLength(0);
  });

  it('routes IDs: AniList is asked with the AniList ID, Jikan with the MAL ID', async () => {
    const { gateway, anilistNet } = setup();
    await gateway.getTitle({ anilist: '16498', mal: '1' });
    expect(anilistNet.variables()).toMatchObject({ id: 16498 });
  });

  it('reports the health of both sources', () => {
    expect(setup().gateway.status()).toEqual({
      primary: { name: 'anilist', breaker: 'closed' },
      fallback: { name: 'jikan', breaker: 'closed' },
    });
    expect(setup({ fallback: false }).gateway.status().fallback).toBeNull();
  });
});

describe('SourceGateway: NFR-REL-001 AniList outage', () => {
  it.each([
    ['500', down(500)],
    ['429', () => jsonResponse(429, {}, { 'Retry-After': '1' })],
    ['a body that is not JSON', () => new Response('<html>', { status: 200 })],
    [
      'a timeout',
      () => {
        throw new DOMException('aborted', 'AbortError');
      },
    ],
  ])('serves search from Jikan when AniList answers %s', async (_label, responder) => {
    const { gateway, anilistNet, fallbacks } = setup();
    anilistNet.responder = responder;
    const result = await gateway.search('attack', {}, PAGE);
    expect(result).toMatchObject({ source: 'jikan', viaFallback: true });
    expect(result.data.items[0]?.externalIds.mal).toBe('16498');
    expect(fallbacks).toHaveLength(1);
  });

  it('the breaker opens after 5 failures, then AniList is not called at all', async () => {
    const { gateway, anilistNet, jikanNet, time } = setup();
    anilistNet.responder = down();
    for (let i = 0; i < 5; i += 1) await gateway.search(`q${i}`, {}, PAGE);
    expect(gateway.status().primary.breaker).toBe('open');

    const calls = anilistNet.requests.length;
    const result = await gateway.search('another', {}, PAGE);
    expect(result.viaFallback).toBe(true);
    expect(anilistNet.requests).toHaveLength(calls); // no request left the building
    expect(jikanNet.requests.length).toBeGreaterThan(0);

    // After 60 s the breaker lets a probe through; AniList is back and the primary resumes.
    time.advance(60_000);
    anilistNet.responder = () => fixtureResponse(fixture('anilist', 'search-attack-on-titan'));
    const recovered = await gateway.search('again', {}, PAGE);
    expect(recovered).toMatchObject({ source: 'anilist', viaFallback: false });
    expect(gateway.status().primary.breaker).toBe('closed');
  });

  it('getTitle falls back to the MAL ID when AniList is down', async () => {
    const { gateway, anilistNet } = setup();
    anilistNet.responder = down();
    const result = await gateway.getTitle({ anilist: '16498', mal: '16498' });
    expect(result).toMatchObject({ source: 'jikan', viaFallback: true });
    expect(result.data?.externalIds).toEqual({ mal: '16498' });
  });

  it('getTitle cannot fall back without a MAL ID, and says nothing could answer', async () => {
    const { gateway, anilistNet, jikanNet } = setup();
    anilistNet.responder = down();
    const error = await gateway.getTitle({ anilist: '16498' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SourcesUnavailableError);
    expect(
      (error as SourcesUnavailableError).causes.map((cause: SourceError) => cause.kind),
    ).toEqual(['unavailable']);
    expect(jikanNet.requests).toHaveLength(0);
  });

  it('both sources down → SourcesUnavailableError naming both causes', async () => {
    const { gateway, anilistNet, jikanNet } = setup();
    anilistNet.responder = down();
    jikanNet.responder = down();
    const error = await gateway.browse({}, PAGE).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SourcesUnavailableError);
    expect((error as SourcesUnavailableError).causes.map((cause) => cause.source)).toEqual([
      'anilist',
      'jikan',
    ]);
  });

  it('without a fallback configured the primary failure is the answer', async () => {
    const { gateway, anilistNet } = setup({ fallback: false });
    anilistNet.responder = down();
    await expect(gateway.search('x', {}, PAGE)).rejects.toBeInstanceOf(SourcesUnavailableError);
  });

  it('airing has no fallback: MAL publishes no air times', async () => {
    const { gateway, anilistNet, jikanNet } = setup();
    anilistNet.responder = down();
    await expect(gateway.getAiring(['1'], new Date(), new Date())).rejects.toBeInstanceOf(
      SourcesUnavailableError,
    );
    expect(jikanNet.requests).toHaveLength(0);
  });
});

describe('SourceGateway: "not found" is an answer', () => {
  it('a title AniList does not know is null, and Jikan is not consulted', async () => {
    const { gateway, anilistNet, jikanNet } = setup();
    anilistNet.responder = () => fixtureResponse(fixture('anilist', 'detail-not-found'));
    const result = await gateway.getTitle({ anilist: '999999999', mal: '999999999' });
    expect(result).toMatchObject({ data: null, source: 'anilist', viaFallback: false });
    expect(jikanNet.requests).toHaveLength(0);
    expect(gateway.status().primary.breaker).toBe('closed');
  });

  it('twenty unknown IDs in a row never open the breaker', async () => {
    const { gateway, anilistNet } = setup();
    anilistNet.responder = () => fixtureResponse(fixture('anilist', 'detail-not-found'));
    for (let id = 1; id <= 20; id += 1) await gateway.getTitle({ anilist: String(id) });
    expect(gateway.status().primary.breaker).toBe('closed');
  });
});
