// Records real AniList responses as test fixtures (apps/api/src/sources/fixtures/anilist).
// Run by hand, rarely: `pnpm --filter @akiba/api run build && node scripts/record-anilist-fixtures.mjs`.
// CI never calls AniList; the contract tests replay these files.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  AIRING_QUERY,
  GENRES_QUERY,
  MEDIA_DETAIL_QUERY,
  MEDIA_PAGE_QUERY,
} from '../apps/api/dist/sources/anilist/queries.js';

const outDir = fileURLToPath(new URL('../apps/api/src/sources/fixtures/anilist/', import.meta.url));
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function record(name, query, variables) {
  const response = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json();
  const fixture = {
    recordedAt: new Date().toISOString(),
    request: { variables },
    status: response.status,
    response: body,
  };
  writeFileSync(`${outDir}${name}.json`, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(name, response.status);
  await sleep(2500);
  return body;
}

await record('search-attack-on-titan', MEDIA_PAGE_QUERY, {
  page: 1,
  perPage: 3,
  search: 'attack on titan',
  isAdult: false,
  sort: ['SEARCH_MATCH'],
});
await record('browse-fall-2024', MEDIA_PAGE_QUERY, {
  page: 1,
  perPage: 4,
  season: 'FALL',
  seasonYear: 2024,
  isAdult: false,
  sort: ['POPULARITY_DESC'],
});
await record('detail-16498', MEDIA_DETAIL_QUERY, { id: 16498 });
await record('detail-not-found', MEDIA_DETAIL_QUERY, { id: 999999999 });
const releasing = await record('browse-releasing', MEDIA_PAGE_QUERY, {
  page: 1,
  perPage: 3,
  status: 'RELEASING',
  isAdult: false,
  sort: ['POPULARITY_DESC'],
});
const ids = releasing.data.Page.media.map((media) => media.id);
const from = Math.floor(Date.now() / 1000);
await record('airing-next-week', AIRING_QUERY, {
  ids,
  from,
  to: from + 7 * 24 * 3600,
  page: 1,
  perPage: 50,
});
await record('genres', GENRES_QUERY, {});
