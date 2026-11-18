// Starts the built API for the browser tests and copies its output to e2e/.tmp/api.log, where
// the tests read the "emails" it prints (no provider is configured: EMAIL_DEV_PRINT_LINKS).
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const databaseUrl = process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    'e2e: set E2E_DATABASE_URL (a migrated PostgreSQL database) before running the browser tests',
  );
  process.exit(1);
}

mkdirSync(fileURLToPath(new URL('./.tmp/', import.meta.url)), { recursive: true });
const log = createWriteStream(fileURLToPath(new URL('./.tmp/api.log', import.meta.url)), {
  flags: 'w',
});
const server = fileURLToPath(new URL('../../api/dist/server.js', import.meta.url));

const child = spawn(process.execPath, [server], {
  env: {
    ...process.env,
    NODE_ENV: 'development',
    PORT: '3100',
    DATABASE_URL: databaseUrl,
    CORS_ORIGINS: 'http://localhost:4173',
    WEB_BASE_URL: 'http://localhost:4173',
    AUTH_COOKIE_SECURE: 'false',
    EMAIL_DEV_PRINT_LINKS: 'true',
    API_RATE_LIMIT_AUTH_MAX: '10000',
    // The whole browser suite shares one IP and runs in minutes; the limits are tested in the API's own suite.
    API_RATE_LIMIT_MAX: '100000',
    API_RATE_LIMIT_WRITE_MAX: '100000',
    LOG_LEVEL: 'warn',
    // The mock source server (e2e/mock-sources.mjs) replays recorded AniList responses.
    SOURCE_ANILIST_URL: 'http://127.0.0.1:3200/graphql',
    SOURCE_JIKAN_URL: 'http://127.0.0.1:3200/v4',
    SOURCE_TIMEOUT_MS: '3000',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.pipe(log);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.on('exit', (code) => process.exit(code ?? 1));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
