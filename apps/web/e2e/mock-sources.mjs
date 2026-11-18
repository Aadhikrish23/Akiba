// A stand-in for AniList and Jikan for the browser tests (CI never calls the live services).
// It replays the responses recorded in apps/api/src/sources/fixtures/anilist, applying the
// filters the real service would, so the screens can be exercised end to end.
//
//   POST /graphql          AniList (GraphQL)
//   GET  /v4/...           Jikan: always 503 (the fallback is exercised by the API's own tests)
//   POST /__mode {"anilist":"down"|"ok"}   simulate an AniList outage
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
const send = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};
const answer = (response, fixture) => send(response, fixture.status, fixture.response);

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
    if (url.pathname === '/__reset') {
      anilistDown = false;
      return send(response, 200, { anilistDown });
    }
    if (url.pathname === '/health') return send(response, 200, { status: 'ok' });
    if (url.pathname.startsWith('/v4')) return send(response, 503, { status: 503 });
    if (url.pathname !== '/graphql' || request.method !== 'POST') return send(response, 404, {});
    if (anilistDown) return send(response, 503, {});

    const { query = '', variables = {} } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (query.includes('query MediaDetail')) {
      return answer(response, variables.id === 16498 ? fixtures.detail : fixtures.notFound);
    }
    if (query.includes('query Genres')) return answer(response, fixtures.genres);
    if (query.includes('query MediaPage')) return send(response, 200, mediaPage(variables));
    return send(response, 400, { errors: [{ message: 'unexpected query' }] });
  });
});

server.listen(3200, '127.0.0.1', () => console.log('mock sources on :3200'));
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => server.close(() => process.exit(0)));
