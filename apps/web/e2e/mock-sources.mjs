// A stand-in for AniList and Jikan for the browser tests (CI never calls the live services).
// It replays the responses recorded in apps/api/src/sources/fixtures/anilist, applying the
// filters the real service would, so the screens can be exercised end to end.
//
//   POST /graphql          AniList (GraphQL)
//   GET  /v4/...           Jikan: always 503 (the fallback is exercised by the API's own tests)
//   POST /__mode {"anilist":"down"|"ok"}   simulate an AniList outage
//   POST /__airing {"episode": n}   which episode the schedule says aired an hour ago (default 8)
//   POST /__reset          back to normal
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const FIXTURES = fileURLToPath(new URL('../../api/src/sources/fixtures/anilist/', import.meta.url));
const load = (name) => JSON.parse(readFileSync(`${FIXTURES}${name}.json`, 'utf8'));
const fixtures = {
  search: load('search-attack-on-titan'),
  browse: load('browse-fall-2024'),
  releasing: load('browse-releasing'),
  detail: load('detail-16498'),
  notFound: load('detail-not-found'),
  genres: load('genres'),
};

let anilistDown = false;
let airingEpisode = 8;
const send = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};
const answer = (response, fixture) => send(response, fixture.status, fixture.response);

/** Three seasons that follow each other and a movie off to the side, for the "one banner" tests. */
function heroSeasons() {
  const season = (id, name, year, edges, format = 'TV') => ({
    id,
    idMal: null,
    title: { romaji: name, english: name, native: null },
    synonyms: [],
    description: null,
    coverImage: { extraLarge: null, large: null, color: '#e4a128' },
    bannerImage: null,
    externalLinks: [
      { site: 'Official Site', url: 'https://example.test/hero', type: 'INFO' },
      {
        site: 'Crunchyroll',
        url: 'http://www.crunchyroll.com/my-hero-academia',
        type: 'STREAMING',
      },
      { site: 'Netflix', url: 'https://www.netflix.com/title/80000000', type: 'STREAMING' },
    ],
    format,
    status: 'FINISHED',
    episodes: format === 'TV' ? 13 : 1,
    duration: 24,
    season: 'SPRING',
    seasonYear: year,
    startDate: { year, month: 4, day: 3 },
    endDate: { year, month: 6, day: 26 },
    averageScore: 80,
    popularity: 5000 - year,
    isAdult: false,
    genres: ['Action'],
    updatedAt: null,
    relations: {
      edges: edges.map(([relationType, target]) => ({
        relationType,
        node: { id: target, idMal: null, type: 'ANIME', format: 'TV', title: { romaji: 'x' } },
      })),
    },
  });
  return [
    season(91001, 'My Hero Academia', 2016, [
      ['SEQUEL', 91002],
      ['SIDE_STORY', 91004],
    ]),
    season(91002, 'My Hero Academia 2', 2017, [
      ['PREQUEL', 91001],
      ['SEQUEL', 91003],
    ]),
    season(91003, 'My Hero Academia 3', 2018, [['PREQUEL', 91002]]),
    season(91004, 'My Hero Academia: The Movie', 2019, [['SIDE_STORY', 91001]], 'MOVIE'),
  ];
}

function mediaPage(variables) {
  const base = variables.search !== undefined ? fixtures.search : fixtures.browse;
  let media = base.response.data.Page.media;
  if (variables.status === 'RELEASING') media = fixtures.releasing.response.data.Page.media;
  if (variables.genre) media = media.filter((item) => item.genres.includes(variables.genre));
  if (variables.format) media = media.filter((item) => item.format === variables.format);
  if (variables.status && variables.status !== 'RELEASING') {
    media = media.filter((item) => item.status === variables.status);
  }
  // The fixture is the fall 2024 chart; any other season is empty.
  if (variables.season && !(variables.season === 'FALL' && variables.seasonYear === 2024))
    media = [];
  if (variables.search !== undefined) {
    const needle = String(variables.search).toLowerCase();
    if (needle.includes('hero academia')) media = heroSeasons();
    media = media.filter((item) =>
      [item.title.romaji, item.title.english, ...(item.synonyms ?? [])]
        .filter(Boolean)
        .some((name) => name.toLowerCase().includes(needle)),
    );
  }
  return {
    data: { Page: { pageInfo: { currentPage: variables.page ?? 1, hasNextPage: false }, media } },
  };
}

const server = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/__mode' && request.method === 'POST') {
      anilistDown = JSON.parse(Buffer.concat(chunks).toString('utf8')).anilist === 'down';
      return send(response, 200, { anilistDown });
    }
    if (url.pathname === '/__airing' && request.method === 'POST') {
      airingEpisode = Number(JSON.parse(Buffer.concat(chunks).toString('utf8')).episode);
      return send(response, 200, { airingEpisode });
    }
    if (url.pathname === '/__reset') {
      anilistDown = false;
      airingEpisode = 8;
      return send(response, 200, { anilistDown });
    }
    if (url.pathname === '/health') return send(response, 200, { status: 'ok' });
    if (url.pathname.startsWith('/v4')) return send(response, 503, { status: 503 });
    if (url.pathname !== '/graphql' || request.method !== 'POST') return send(response, 404, {});
    if (anilistDown) return send(response, 503, {});

    const { query = '', variables = {} } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (query.includes('query MediaDetail')) {
      const hero = heroSeasons().find((season) => season.id === variables.id);
      if (hero !== undefined) {
        return send(response, 200, {
          data: {
            Media: {
              ...hero,
              studios: { edges: [] },
              nextAiringEpisode: null,
              streamingEpisodes: [],
              characters: { edges: [] },
            },
          },
        });
      }
      return answer(response, variables.id === 16498 ? fixtures.detail : fixtures.notFound);
    }
    if (query.includes('query Airing')) {
      // Every title asked about has had one episode air an hour ago (the real clock, so the API's
      // own jobs treat it as just aired).
      const airingAt = Math.floor(Date.now() / 1000) - 3600;
      const ids = Array.isArray(variables.ids) ? variables.ids : [];
      return send(response, 200, {
        data: {
          Page: {
            pageInfo: { currentPage: 1, hasNextPage: false },
            airingSchedules: ids.map((mediaId) => ({ episode: airingEpisode, airingAt, mediaId })),
          },
        },
      });
    }
    if (query.includes('query Genres')) return answer(response, fixtures.genres);
    if (query.includes('query MediaPage')) return send(response, 200, mediaPage(variables));
    return send(response, 400, { errors: [{ message: 'unexpected query' }] });
  });
});

server.listen(3200, '127.0.0.1', () => console.log('mock sources on :3200'));
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => server.close(() => process.exit(0)));
