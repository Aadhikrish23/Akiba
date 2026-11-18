import type { RequestHandler, Router } from 'express';
import type { DbClient } from '../../db/index.js';
import { createInboxRouter } from './inbox.routes.js';
import { createInboxService, type InboxService } from './inbox.service.js';

export type { InboxService } from './inbox.service.js';

export interface InboxModuleOptions {
  readonly db: DbClient;
  /** From the auth module: access token, live session, per-user limits. */
  readonly authenticated: readonly RequestHandler[];
  readonly now?: () => Date;
}

export interface InboxModule {
  readonly router: Router;
  readonly service: InboxService;
}

export function createInboxModule(options: InboxModuleOptions): InboxModule {
  const service = createInboxService({
    db: options.db,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { router: createInboxRouter({ service, authenticated: options.authenticated }), service };
}
