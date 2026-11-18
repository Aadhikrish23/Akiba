import request from 'supertest';
import type { DbClient } from '../db/index.js';
import { createLogger } from '../lib/logger.js';
import { createAccountModule } from '../modules/account/index.js';
import { createInboxModule } from '../modules/inbox/index.js';
import { createLibraryModule } from '../modules/library/index.js';
import { createTitlesModule, type TitlesModule } from '../modules/titles/index.js';
import { createAniListAdapter } from '../sources/anilist/anilistAdapter.js';
import { SourceGateway } from '../sources/gateway.js';
import { createJikanAdapter } from '../sources/jikan/jikanAdapter.js';
import {
  buildAuthTestApp,
  loginMobile,
  newCredentials,
  register,
  type AuthTestApp,
} from './auth.js';
import { LogSink, testConfig } from './harness.js';
import {
  FakeNet,
  ManualTime,
  fixture,
  fixtureResponse,
  jsonResponse,
  type RecordedRequest,
} from './sources.js';

/**
 * The real API (auth + titles) on a real database, with both metadata sources replaced by fake
 * networks that replay recorded AniList responses and hand-written Jikan ones.
 */
export interface CatalogTestApp extends AuthTestApp {
  readonly anilist: FakeNet;
  readonly jikan: FakeNet;
  readonly gateway: SourceGateway;
  readonly time: ManualTime;
  /** The discovery service, for the jobs that use it (metadata refresh). */
  readonly titles: TitlesModule['service'];
  readonly logger: ReturnType<typeof createLogger>;
  /** Register and log in a fresh user; resolves with their bearer header. */
  signIn(label?: string): Promise<{ readonly userId: string; readonly auth: string }>;
  get(path: string, auth: string): request.Test;
}

/** AniList as it was recorded: search and browse pages, one detail, genres. */
export function recordedAniList(request: RecordedRequest): Response {
  const query = (request.body?.['query'] as string | undefined) ?? '';
  const variables = (request.body?.['variables'] ?? {}) as Record<string, unknown>;
  if (query.includes('query MediaDetail')) {
    return variables['id'] === 16498
      ? fixtureResponse(fixture('anilist', 'detail-16498'))
      : fixtureResponse(fixture('anilist', 'detail-not-found'));
  }
  if (query.includes('query Genres')) return fixtureResponse(fixture('anilist', 'genres'));
  if (query.includes('query MediaPage')) {
    return fixtureResponse(
      fixture(
        'anilist',
        variables['search'] === undefined ? 'browse-fall-2024' : 'search-attack-on-titan',
      ),
    );
  }
  return jsonResponse(400, { errors: [{ message: 'unexpected query' }] });
}

export function recordedJikan(request: RecordedRequest): Response {
  const path = new URL(request.url).pathname;
  if (path.endsWith('/full')) return fixtureResponse(fixture('jikan', 'detail-16498'));
  if (path.endsWith('/genres/anime')) return fixtureResponse(fixture('jikan', 'genres'));
  if (path.includes('/seasons/')) return fixtureResponse(fixture('jikan', 'season-fall-2024'));
  return fixtureResponse(fixture('jikan', 'search-attack'));
}

export async function buildCatalogTestApp(options: {
  readonly db: DbClient;
  readonly anilist?: (request: RecordedRequest) => Response | Promise<Response>;
  readonly jikan?: (request: RecordedRequest) => Response | Promise<Response>;
  readonly fallback?: boolean;
}): Promise<CatalogTestApp> {
  const time = new ManualTime();
  const anilist = new FakeNet(options.anilist ?? recordedAniList);
  const jikan = new FakeNet(options.jikan ?? recordedJikan);
  const common = { now: time.now, sleep: time.sleep, random: () => 0, requestsPerMinute: 60_000 };
  const gateway = new SourceGateway({
    primary: createAniListAdapter({ fetch: anilist.fetch, ...common }),
    ...(options.fallback === false
      ? {}
      : {
          fallback: createJikanAdapter({
            url: 'https://jikan.example.test/v4',
            fetch: jikan.fetch,
            ...common,
          }),
        }),
  });
  const logger = createLogger({ level: 'silent', destination: new LogSink() });
  let titlesModule: TitlesModule | undefined;
  const app = await buildAuthTestApp({
    db: options.db,
    extraRouters: (auth, context) => [
      createAccountModule({
        config: context.config,
        db: options.db,
        auth,
        rateLimitStore: context.rateLimitStore,
      }).router,
      // The library runs on the real clock: its ordering and dates are what its tests check.
      createLibraryModule({ db: options.db, authenticated: auth.authenticated }).router,
      createInboxModule({ db: options.db, authenticated: auth.authenticated }).router,
      (titlesModule = createTitlesModule({
        config: testConfig(),
        db: options.db,
        logger,
        authenticated: auth.authenticated,
        gateway,
        now: () => new Date(time.now()),
      })).router,
    ],
  });
  if (titlesModule === undefined) throw new Error('the titles module was not built');
  return {
    ...app,
    anilist,
    jikan,
    gateway,
    time,
    titles: titlesModule.service,
    logger,
    async signIn(label = 'catalog') {
      const credentials = newCredentials(label);
      await register(app.app, credentials);
      const session = await loginMobile(app.app, credentials);
      return { userId: session.userId, auth: `Bearer ${session.accessToken}` };
    },
    get: (path, auth) => request(app.app).get(`/v1${path}`).set('Authorization', auth),
  };
}

/** True for AniList's airing-schedule query (the one the jobs send). */
export function isAiringQuery(request: RecordedRequest): boolean {
  const query = request.body?.['query'];
  return typeof query === 'string' && query.includes('query Airing');
}
