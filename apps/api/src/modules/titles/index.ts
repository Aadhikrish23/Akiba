import { Router, type RequestHandler } from 'express';
import type { AppConfig } from '../../config/env.js';
import type { DbClient } from '../../db/index.js';
import type { Logger } from '../../lib/logger.js';
import { createTitleResolver } from '../../mapping/index.js';
import { createSourceGateway, type SourceGateway } from '../../sources/index.js';
import { createExploreRouter } from '../explore/explore.routes.js';
import { createExploreService } from '../explore/explore.service.js';
import { createTitlesRouter } from './titles.routes.js';
import { createTitlesService, type TitlesService } from './titles.service.js';

export type { TitlesService } from './titles.service.js';

export interface TitlesModuleOptions {
  readonly config: AppConfig;
  readonly db: DbClient;
  readonly logger: Logger;
  /** From the auth module: access token, live session, per-user limits. */
  readonly authenticated: readonly RequestHandler[];
  /** Tests pass a gateway over fake networks; production builds the real one from the config. */
  readonly gateway?: SourceGateway;
  readonly now?: () => Date;
}

export interface TitlesModule {
  readonly router: Router;
  readonly service: TitlesService;
  readonly gateway: SourceGateway;
}

const USER_AGENT = 'Akiba/0.1 (anime library; metadata cache)';

/** Wire the discovery module: AniList primary, Jikan fallback, Akiba ID resolver, catalog cache. */
export function createTitlesModule(options: TitlesModuleOptions): TitlesModule {
  const { config, db, logger } = options;
  const gateway =
    options.gateway ??
    createSourceGateway({
      anilist: {
        timeoutMs: config.sources.timeoutMs,
        userAgent: USER_AGENT,
        ...(config.sources.anilistUrl === undefined ? {} : { url: config.sources.anilistUrl }),
      },
      jikan: {
        timeoutMs: config.sources.timeoutMs,
        userAgent: USER_AGENT,
        ...(config.sources.jikanUrl === undefined ? {} : { url: config.sources.jikanUrl }),
      },
      onFallback: ({ operation, primaryError }) => {
        logger.warn(
          { operation, kind: primaryError.kind, source: primaryError.source },
          'primary metadata source failed; trying the fallback',
        );
      },
    });
  const resolver = createTitleResolver(db, options.now === undefined ? {} : { now: options.now });
  const service = createTitlesService({
    db,
    gateway,
    resolver,
    logger,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return {
    router: Router().use(
      createTitlesRouter({ service, authenticated: options.authenticated }),
      createExploreRouter({
        service: createExploreService({ db }),
        authenticated: options.authenticated,
      }),
    ),
    service,
    gateway,
  };
}
