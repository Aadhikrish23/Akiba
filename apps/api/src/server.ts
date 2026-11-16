import { createApp } from './app.js';
import { EnvError, loadEnv, type AppConfig } from './config/env.js';
import { createTcpDbCheck, dbNotConfigured } from './lib/dbCheck.js';
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

const app = createApp({
  config,
  logger,
  checkDb:
    config.databaseUrl === undefined ? dbNotConfigured : createTcpDbCheck(config.databaseUrl),
});

const server = app.listen(config.port, () => {
  logger.info({ port: config.port, nodeEnv: config.nodeEnv }, 'api listening');
});

server.on('error', (error) => {
  logger.fatal({ err: error }, 'server failed to start');
  process.exit(1);
});

const shutdown = createShutdown({ server, logger, timeoutMs: config.shutdownTimeoutMs });

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void shutdown(signal).then((exitCode) => {
      process.exit(exitCode);
    });
  });
}
