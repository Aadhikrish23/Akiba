import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Creates the migrated template database that DB-backed suites copy (needs DATABASE_URL).
    globalSetup: ['src/testing/globalSetup.ts'],
    // Spawning the Prisma CLI and creating databases takes longer than a unit test.
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
