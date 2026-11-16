import { randomBytes } from 'node:crypto';
import type { TestProject } from 'vitest/node';
import {
  createDatabase,
  dropDatabase,
  listDatabases,
  TEST_DATABASE_PREFIX,
  urlForDatabase,
} from './databaseAdmin.js';
import { runPrisma } from './prismaCli.js';

export interface TestDatabaseContext {
  /** Connection URL of the server the test databases are created on. */
  readonly serverUrl: string;
  /** Prefix of every database this run creates. */
  readonly runPrefix: string;
  /** Fully migrated database that suites copy with `CREATE DATABASE ... TEMPLATE`. */
  readonly template: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    testDatabase: TestDatabaseContext;
  }
}

/**
 * Runs once per `vitest run`: creates an empty database, applies the committed migrations to it
 * with the real `prisma migrate deploy`, and offers it to the suites as a template. Everything
 * the run created is dropped afterwards.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const serverUrl = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
  if (serverUrl === undefined || serverUrl === '') {
    throw new Error(
      'The API tests need PostgreSQL 16. Set DATABASE_URL (or TEST_DATABASE_URL) to a server ' +
        'where the role may create databases; the tests create and drop their own akiba_t_* ' +
        'databases and leave the named database alone. See the README, "Database".',
    );
  }

  const runPrefix = `${TEST_DATABASE_PREFIX}${Date.now().toString(36)}${randomBytes(3).toString('hex')}_`;
  const template = `${runPrefix}template`;

  const dropAll = async (): Promise<void> => {
    for (const name of await listDatabases(serverUrl, runPrefix)) {
      await dropDatabase(serverUrl, name);
    }
  };

  try {
    await createDatabase(serverUrl, template);
    const migrate = await runPrisma(['migrate', 'deploy'], urlForDatabase(serverUrl, template));
    if (migrate.code !== 0) {
      throw new Error(`prisma migrate deploy failed on the test template:\n${migrate.output}`);
    }
  } catch (error) {
    await dropAll().catch(() => undefined);
    throw error;
  }

  project.provide('testDatabase', { serverUrl, runPrefix, template });
  return dropAll;
}
