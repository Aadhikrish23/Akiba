import { EnvError, loadEnv } from '../config/env.js';
import { createDb } from '../db/index.js';
import { createLogger } from '../lib/logger.js';
import { createTitlesModule } from '../modules/titles/index.js';
import { createJobScheduler } from './index.js';

// Entry point for `pnpm jobs:run <job>`: run one background job once, now, and print what it did.
// The same jobs the API's scheduler runs, under the same advisory lock (so it is safe next to a
// running API). Used by operators, and by the browser tests to make an episode "air".
const USAGE = `usage:
  pnpm jobs:run <job>

jobs: airing-sync, inbox-fanout, metadata-refresh, account-cleanup`;

const [name] = process.argv.slice(2);
if (name === undefined) {
  console.error(USAGE);
  process.exit(2);
}

let config;
try {
  config = loadEnv();
} catch (error) {
  console.error('jobs:', error instanceof EnvError ? error.message : error);
  process.exit(1);
}
if (config.databaseUrl === undefined) {
  console.error('jobs: DATABASE_URL is not set');
  process.exit(1);
}

const logger = createLogger({ level: config.logLevel });
const db = createDb({ databaseUrl: config.databaseUrl, maxConnections: 3 });
try {
  const titles = createTitlesModule({ config, db: db.client, logger, authenticated: [] });
  const scheduler = createJobScheduler({
    db: db.client,
    gateway: titles.gateway,
    titles: titles.service,
    logger,
  });
  if (!scheduler.jobs.includes(name)) {
    console.error(`jobs: unknown job "${name}"\n${USAGE}`);
    process.exitCode = 2;
  } else {
    const outcome = await scheduler.runNow(name);
    if (outcome.status === 'ran') {
      console.log(`jobs: ${name} finished in ${outcome.ms} ms: ${JSON.stringify(outcome.result)}`);
    } else if (outcome.status === 'locked') {
      console.log(`jobs: ${name} is already running elsewhere; nothing done`);
    } else {
      console.error(`jobs: ${name} failed`);
      process.exitCode = 1;
    }
  }
} finally {
  await db.close();
}
