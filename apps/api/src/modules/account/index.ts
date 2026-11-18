import type { Router } from 'express';
import type { AppConfig } from '../../config/env.js';
import type { DbClient } from '../../db/index.js';
import { createRateLimiter, type RateLimitStore } from '../../middleware/rateLimit.js';
import type { AuthModule } from '../auth/index.js';
import { createAccountRouter } from './account.routes.js';
import { createAccountService, type AccountService } from './account.service.js';

export type { AccountService } from './account.service.js';
export { csvCell } from './account.service.js';

export interface AccountModuleOptions {
  readonly config: AppConfig;
  readonly db: DbClient;
  readonly auth: AuthModule;
  readonly rateLimitStore: RateLimitStore;
  readonly now?: () => Date;
}

export interface AccountModule {
  readonly router: Router;
  readonly service: AccountService;
}

/** Public shared pages per IP per minute: enough to browse, too few to guess tokens. */
const SHARED_LIMIT_PER_MINUTE = 60;

export function createAccountModule(options: AccountModuleOptions): AccountModule {
  const { config, auth } = options;
  const now = options.now ?? (() => new Date());
  const service = createAccountService({
    db: options.db,
    auth: auth.service,
    webBaseUrl: config.email.webBaseUrl,
    now,
  });
  return {
    router: createAccountRouter({
      service,
      auth: auth.service,
      authenticated: auth.authenticated,
      verifiedEmail: auth.verifiedEmail,
      publicLimiter: createRateLimiter({
        name: 'shared',
        windowMs: 60_000,
        max: SHARED_LIMIT_PER_MINUTE,
        store: options.rateLimitStore,
        now: () => now().getTime(),
      }),
      cookieSecure: config.auth.cookieSecure,
      now,
    }),
    service,
  };
}
