import { createApp } from './app.js';
import { EnvError, loadEnv, type AppConfig } from './config/env.js';
import { createDb } from './db/index.js';
import { createDbCheck, dbNotConfigured } from './lib/dbCheck.js';
import { createLogger } from './lib/logger.js';
import { createShutdown } from './lib/shutdown.js';

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

const app = createApp({
  config,
  logger,
  checkDb: db === undefined ? dbNotConfigured : createDbCheck(db),
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
  ...(db === undefined ? {} : { onClose: () => db.close() }),
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void shutdown(signal).then((exitCode) => {
      process.exit(exitCode);
    });
  });
}
