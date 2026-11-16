import { APP_NAME } from '@akiba/shared';
import express, { type Express, type Router } from 'express';
import { MAX_BODY_BYTES } from './config/constants.js';
import type { AppConfig } from './config/env.js';
import { dbNotConfigured, type DbCheck } from './lib/dbCheck.js';
import type { Logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import {
  createRateLimiter,
  isWriteRequest,
  MemoryRateLimitStore,
  type RateLimitStore,
} from './middleware/rateLimit.js';
import { requestId } from './middleware/requestId.js';
import { requestLogger } from './middleware/requestLogger.js';
import { corsAllowList, securityHeaders } from './middleware/security.js';
import { createHealthRouter } from './modules/health/health.routes.js';

export interface AppDependencies {
  readonly config: AppConfig;
  readonly logger: Logger;
  /** Database readiness probe for `/ready`. Defaults to reporting `not_configured`. */
  readonly checkDb?: DbCheck;
  /** Counter store for the rate limiters. Defaults to a fresh in-memory store. */
  readonly rateLimitStore?: RateLimitStore;
  /** Routes served under `/v1` (doc 07). None exist yet; feature modules add theirs from T4 on. */
  readonly v1Router?: Router;
}

/**
 * Build the Express application without binding a port. All dependencies are passed in, so tests
 * can run it on an ephemeral port with their own config, log sink and probes.
 *
 * Order matters: request ID first (so everything is correlated), then logging, security headers
 * and CORS (so even error responses carry them), rate limiting before any body is read, then the
 * body parser, routes, the 404 handler and the problem-details error handler.
 */
export function createApp(dependencies: AppDependencies): Express {
  const { config, logger } = dependencies;
  const store = dependencies.rateLimitStore ?? new MemoryRateLimitStore();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxyHops);
  app.locals.name = APP_NAME;

  app.use(requestId(logger));
  app.use(requestLogger(logger));
  app.use(securityHeaders());
  app.use(corsAllowList(config.corsOrigins));

  // Per-IP budgets (NFR-SEC-005). Liveness is exempt so a probe is never throttled.
  app.use(
    createRateLimiter({
      name: 'global',
      windowMs: config.rateLimit.windowMs,
      max: config.rateLimit.max,
      store,
      skip: (req) => req.path === '/health',
    }),
  );
  app.use(
    createRateLimiter({
      name: 'write',
      windowMs: config.rateLimit.windowMs,
      max: config.rateLimit.writeMax,
      store,
      skip: (req) => !isWriteRequest(req),
    }),
  );

  app.use(express.json({ limit: MAX_BODY_BYTES }));

  app.use(createHealthRouter({ checkDb: dependencies.checkDb ?? dbNotConfigured, logger }));
  if (dependencies.v1Router) {
    app.use('/v1', dependencies.v1Router);
  }

  app.use(notFoundHandler);
  app.use(errorHandler({ logger, nodeEnv: config.nodeEnv }));
  return app;
}
