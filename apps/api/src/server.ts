import { createApp } from './app.js';
import { EnvError, loadEnv, type AppConfig } from './config/env.js';
import { createDb } from './db/index.js';
import { createDbCheck, dbNotConfigured } from './lib/dbCheck.js';
import { createLogger } from './lib/logger.js';
import { createShutdown } from './lib/shutdown.js';
import { MemoryRateLimitStore } from './middleware/rateLimit.js';
import { createAuthModule } from './modules/auth/index.js';
import { createLibraryModule } from './modules/library/index.js';
import { createTitlesModule } from './modules/titles/index.js';
import { composeV1 } from './modules/v1.js';

/** How long shutdown waits for emails that are still on their way out. */
const BACKGROUND_DRAIN_MS = 5_000;

function loadConfigOrExit(): AppConfig {
  try {
    return loadEnv();
  } catch (error) {
    // The logger needs config to exist, so a boot failure is written to stderr directly.
    console.error(error instanceof EnvError ? error.message : error);
    process.exit(1);
  }
}

const config = loadConfigOrExit();
const logger = createLogger({ level: config.logLevel });

// Creating the handle does not connect, so the API still boots while the database is down and
// reports that through /ready.
const db =
  config.databaseUrl === undefined
    ? undefined
    : createDb({
        databaseUrl: config.databaseUrl,
        onPoolError: (error) => {
          logger.error({ err: error }, 'database pool error');
        },
      });

// One store for every limiter (per-IP in the app, per-IP and per-user in the auth module).
const rateLimitStore = new MemoryRateLimitStore();

// The auth module needs the database; without one (development only) `/v1` has no routes.
const auth =
  db === undefined
    ? undefined
    : await createAuthModule({ config, db: db.client, logger, rateLimitStore });
if (auth === undefined) {
  logger.warn('DATABASE_URL is not set: the /v1 routes are not available');
}

const titles =
  db === undefined || auth === undefined
    ? undefined
    : createTitlesModule({ config, db: db.client, logger, authenticated: auth.authenticated });

const library =
  db === undefined || auth === undefined
    ? undefined
    : createLibraryModule({ db: db.client, authenticated: auth.authenticated });

const app = createApp({
  config,
  logger,
  rateLimitStore,
  checkDb: db === undefined ? dbNotConfigured : createDbCheck(db),
  ...(titles === undefined
    ? {}
    : {
        checkSources: () =>
          titles.gateway.status().primary.breaker === 'closed' ? 'ok' : 'degraded',
      }),
  ...(auth === undefined
    ? {}
    : {
        v1Router: composeV1(
          auth.router,
          ...(titles === undefined ? [] : [titles.router]),
          ...(library === undefined ? [] : [library.router]),
        ),
      }),
});

const server = app.listen(config.port, () => {
  logger.info({ port: config.port, nodeEnv: config.nodeEnv }, 'api listening');
});

server.on('error', (error) => {
  logger.fatal({ err: error }, 'server failed to start');
  process.exit(1);
});

const shutdown = createShutdown({
  server,
  logger,
  timeoutMs: config.shutdownTimeoutMs,
  ...(db === undefined
    ? {}
    : {
        onClose: async () => {
          // Let emails that are on their way out finish before the pool goes away.
          // Bounded: a provider that never answers must not keep the process alive.
          if (auth !== undefined && !(await auth.background.idle(BACKGROUND_DRAIN_MS))) {
            logger.warn(
              { pending: auth.background.pending },
              'background work abandoned at shutdown',
            );
          }
          await db.close();
        },
      }),
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void shutdown(signal).then((exitCode) => {
      process.exit(exitCode);
    });
  });
}
