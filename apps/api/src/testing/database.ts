import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { createDb, type Db } from '../db/index.js';
import { createDatabase, dropDatabase, urlForDatabase } from './databaseAdmin.js';

export interface TestDatabase {
  readonly name: string;
  readonly url: string;
  /** The application's database module, connected to this database. */
  readonly db: Db;
  /**
   * A plain node-postgres pool on the same database, for asserting on what PostgreSQL itself
   * says (SQLSTATE, constraint name) without Prisma in between.
   */
  readonly sql: pg.Pool;
  /** Empty every table (keeps the schema and the migration history). */
  reset(): Promise<void>;
  /** Disconnect and drop the database. */
  drop(): Promise<void>;
}

export interface TestDatabaseOptions {
  /** `migrated` (default): a copy of the migrated template. `empty`: a database with nothing. */
  readonly state?: 'migrated' | 'empty';
}

/**
 * Create a database that belongs to the calling suite alone. Suites run in parallel, so each
 * one gets its own copy; call `reset()` between tests and `drop()` in `afterAll`.
 */
export async function createTestDatabase(options: TestDatabaseOptions = {}): Promise<TestDatabase> {
  const context = inject('testDatabase');
  const name = `${context.runPrefix}${randomBytes(6).toString('hex')}`;
  await createDatabase(
    context.serverUrl,
    name,
    options.state === 'empty' ? undefined : context.template,
  );

  const url = urlForDatabase(context.serverUrl, name);
  const db = createDb({ databaseUrl: url, maxConnections: 5 });
  const sql = new pg.Pool({ connectionString: url, max: 3 });
  // An idle connection is cut when the database is force-dropped; that is expected here.
  sql.on('error', () => undefined);

  let tables: string | undefined;

  return {
    name,
    url,
    db,
    sql,
    async reset() {
      if (tables === undefined) {
        const result = await sql.query<{ tablename: string }>(
          `SELECT tablename FROM pg_tables
           WHERE schemaname = current_schema() AND tablename <> '_prisma_migrations'`,
        );
        tables = result.rows.map((row) => `"${row.tablename}"`).join(', ');
      }
      if (tables === '') return;
      const client = await sql.connect();
      try {
        await client.query('BEGIN');
        // `event` is append-only; emptying it is the documented purge exception.
        await client.query(`SELECT set_config('akiba.event_maintenance', 'purge', true)`);
        await client.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async drop() {
      await db.close().catch(() => undefined);
      await sql.end().catch(() => undefined);
      await dropDatabase(context.serverUrl, name);
    },
  };
}

/** The interesting fields of a PostgreSQL error, for `expect(...).toMatchObject(...)`. */
export interface PgFailure {
  readonly code: string | undefined;
  readonly constraint: string | undefined;
  readonly message: string;
}

/** Run a statement that must fail and return why. Fails the test if it succeeds. */
export async function pgFailure(run: () => Promise<unknown>): Promise<PgFailure> {
  try {
    await run();
  } catch (error) {
    const failure = error as { code?: string; constraint?: string; message?: string };
    return {
      code: failure.code,
      constraint: failure.constraint,
      message: failure.message ?? String(error),
    };
  }
  throw new Error('expected the statement to be rejected by the database, but it succeeded');
}
