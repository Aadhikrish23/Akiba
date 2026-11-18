import { defineConfig } from '@playwright/test';

/**
 * Browser tests (doc 11): the built web app, the built API and a migrated database. Needs
 * E2E_DATABASE_URL. Uses the Chrome that is installed on the machine (`channel: 'chrome'`), so no
 * browser download is needed; CI runners have Chrome.
 */
export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    channel: 'chrome',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'node e2e/start-api.mjs',
      url: 'http://localhost:3100/health',
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'pnpm run build && pnpm exec vite preview --port 4173 --strictPort',
      url: 'http://localhost:4173',
      reuseExistingServer: false,
      timeout: 120_000,
      env: { API_PROXY_TARGET: 'http://localhost:3100' },
    },
  ],
});
