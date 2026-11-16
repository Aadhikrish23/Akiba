import { Router, type RequestHandler } from 'express';
import { AUTH_LIFETIMES } from '../../config/constants.js';
import type { AppConfig } from '../../config/env.js';
import type { DbClient } from '../../db/index.js';
import { BackgroundTasks } from '../../lib/backgroundTasks.js';
import type { Logger } from '../../lib/logger.js';
import { requireAuth, userRateLimit } from '../../middleware/auth.js';
import {
  createRateLimiter,
  MemoryRateLimitStore,
  type RateLimitStore,
} from '../../middleware/rateLimit.js';
import { createEmailSender, createEmailTemplates, type EmailSender } from '../email/index.js';
import { JwtAccessTokenService, loadAccessTokenKeys } from './accessTokens.js';
import { createAuthRouter, createMeRouter, requireVerifiedEmail } from './auth.routes.js';
import { createAuthService, type AuthService } from './auth.service.js';
import {
  AnyChecker,
  createHibpFetcher,
  HibpRangeChecker,
  LocalListChecker,
  type BreachedPasswordChecker,
} from './breachedPasswords.js';
import { MemoryLoginThrottle, type LoginThrottle } from './loginThrottle.js';
import { OneTimeTokenStore } from './oneTimeTokens.js';
import { Argon2idHasher, createDummyHash, type PasswordHasher } from './password.js';
import { RefreshTokenStore } from './refreshTokens.js';

export type { AuthService } from './auth.service.js';

export interface AuthModuleOptions {
  readonly config: AppConfig;
  readonly db: DbClient;
  readonly logger: Logger;
  /** Shared with the app's other limiters so all budgets live in one store. */
  readonly rateLimitStore: RateLimitStore;
  /** Clock for token lifetimes, throttling and rate limits. Tests pass a controllable one. */
  readonly now?: () => Date;
  /** Overrides for tests (observe hashing, replace the breach check or the throttle). */
  readonly hasher?: PasswordHasher;
  readonly breachedPasswords?: BreachedPasswordChecker;
  readonly loginThrottle?: LoginThrottle;
  /** Defaults to the sender named by `EMAIL_PROVIDER`. Tests pass an in-memory one. */
  readonly emailSender?: EmailSender;
  /**
   * Counters for the per-address email budget. Its window (an hour) differs from the request
   * limiters', so it defaults to a store of its own rather than `rateLimitStore`.
   */
  readonly emailBudgetStore?: RateLimitStore;
}

export interface AuthModule {
  readonly service: AuthService;
  /** Mount under `/v1`: `/auth/*` and `/me`. */
  readonly router: Router;
  /**
   * Middleware chain for every authenticated route of later modules: verifies the access token
   * and its session, then applies the per-user rate limits. Read the caller with `getAuth(res)`.
   */
  readonly authenticated: readonly RequestHandler[];
  /**
   * Put AFTER `authenticated` on routes that need a verified email address (Q-04: share links).
   * Answers 403 `EMAIL_NOT_VERIFIED` otherwise.
   */
  readonly verifiedEmail: RequestHandler;
  /**
   * Work still running after responses were sent (email delivery, forgot-password). Await
   * `background.idle()` before closing the database.
   */
  readonly background: BackgroundTasks;
}

/** Wire the auth module together. The only place that knows which implementations are used. */
export async function createAuthModule(options: AuthModuleOptions): Promise<AuthModule> {
  const { config, db, logger, rateLimitStore } = options;
  const now = options.now ?? (() => new Date());
  const nowMs = (): number => now().getTime();

  const keys = await loadAccessTokenKeys(config.auth.jwt);
  if (keys.ephemeral) {
    logger.warn(
      'AUTH_JWT_PRIVATE_JWK is not set: using a signing key generated for this process only; ' +
        'access tokens will not survive a restart (run `pnpm auth:gen-key` to create one)',
    );
  }

  const localList = new LocalListChecker();
  const breachedPasswords =
    options.breachedPasswords ??
    (config.auth.hibpEnabled
      ? new AnyChecker([
          localList,
          new HibpRangeChecker(createHibpFetcher(), (error) => {
            logger.warn({ err: error }, 'breached-password range lookup failed; continuing');
          }),
        ])
      : localList);

  const hasher =
    options.hasher ??
    new Argon2idHasher({
      memoryKib: config.auth.argon2.memoryKib,
      timeCost: config.auth.argon2.timeCost,
      pepper: config.auth.passwordPepper,
    });

  const background = new BackgroundTasks(logger);
  const refreshTokens = new RefreshTokenStore({
    db,
    now,
    lifetimes: {
      idleMs: AUTH_LIFETIMES.refreshIdleMs,
      absoluteMs: AUTH_LIFETIMES.refreshAbsoluteMs,
    },
  });

  const service = createAuthService({
    db,
    logger,
    now,
    background,
    oneTimeTokens: new OneTimeTokenStore({ db, now }),
    emailSender: options.emailSender ?? createEmailSender(config, logger),
    emailTemplates: createEmailTemplates({ webBaseUrl: config.email.webBaseUrl }),
    emailBudgetStore: options.emailBudgetStore ?? new MemoryRateLimitStore(),
    hasher,
    // Made before the first request, so even the very first login for an unknown address does
    // exactly one verification, like any other (S-AUTH-3). Also proves at boot that hashing works.
    dummyHash: await createDummyHash(hasher),
    breachedPasswords,
    accessTokens: new JwtAccessTokenService({
      keys,
      issuer: config.auth.jwt.issuer,
      audience: config.auth.jwt.audience,
      lifetimeSeconds: AUTH_LIFETIMES.accessTokenSeconds,
      now,
    }),
    refreshTokens,
    loginThrottle: options.loginThrottle ?? new MemoryLoginThrottle(),
  });

  const authenticated: readonly RequestHandler[] = [
    requireAuth(service),
    ...userRateLimit({
      windowMs: config.rateLimit.windowMs,
      max: config.rateLimit.max,
      writeMax: config.rateLimit.writeMax,
      store: rateLimitStore,
      now: nowMs,
    }),
  ];

  const router = Router();
  router.use(
    '/auth',
    createAuthRouter({
      service,
      authenticated,
      allowedOrigins: config.corsOrigins,
      cookieSecure: config.auth.cookieSecure,
      now,
      ipLimiter: createRateLimiter({
        name: 'auth',
        windowMs: config.rateLimit.windowMs,
        max: config.rateLimit.authMax,
        store: rateLimitStore,
        now: nowMs,
      }),
    }),
  );
  router.use(createMeRouter({ service, authenticated }));

  return {
    service,
    router,
    authenticated,
    verifiedEmail: requireVerifiedEmail(service),
    background,
  };
}
