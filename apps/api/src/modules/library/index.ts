import type { RequestHandler, Router } from 'express';
import type { DbClient } from '../../db/index.js';
import { createLibraryRouter } from './library.routes.js';
import { createLibraryService, type LibraryService } from './library.service.js';

export type { LibraryService } from './library.service.js';

export interface LibraryModuleOptions {
  readonly db: DbClient;
  /** From the auth module: access token, live session, per-user limits. */
  readonly authenticated: readonly RequestHandler[];
  readonly now?: () => Date;
}

export interface LibraryModule {
  readonly router: Router;
  readonly service: LibraryService;
}

export function createLibraryModule(options: LibraryModuleOptions): LibraryModule {
  const service = createLibraryService({
    db: options.db,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return {
    router: createLibraryRouter({ service, authenticated: options.authenticated }),
    service,
  };
}
