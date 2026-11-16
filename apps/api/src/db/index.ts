import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../generated/prisma/client.js';

/**
 * The one place the API obtains database access. Everything else imports the client type, the
 * `Prisma` namespace (error classes, input types, `Prisma.sql`) and the enums from here, never
 * from the generated code directly, so the generator's location and options stay private to this
 * module.
 */
export { Prisma, PrismaClient };
export * from '../generated/prisma/enums.js';

export type DbClient = PrismaClient;
/** The client handed to an interactive `$transaction` callback. */
export type DbTransaction = Prisma.TransactionClient;

export interface Db {
  readonly client: DbClient;
  /** Runs `SELECT 1`. Rejects when the database cannot be reached, authenticated or queried. */
  ping(): Promise<void>;
  /** Closes every pooled connection (graceful shutdown). */
  close(): Promise<void>;
}

export interface DbOptions {
  /** `postgresql://user:password@host:port/database[?schema=name]`. */
  readonly databaseUrl: string;
  /** Upper bound on pooled connections (pg default: 10). */
  readonly maxConnections?: number;
  /** How long to wait for a connection before a query fails. */
  readonly connectionTimeoutMs?: number;
  /** Called for errors on idle pooled connections (e.g. the server went away). */
  readonly onPoolError?: (error: Error) => void;
}

const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;

/**
 * Split Prisma's `?schema=` parameter off the URL. node-postgres does not know it; the adapter
 * takes the schema as an option, and raw SQL needs it on the search path.
 */
function splitSchema(databaseUrl: string): { connectionString: string; schema?: string } {
  const url = new URL(databaseUrl);
  const schema = url.searchParams.get('schema');
  url.searchParams.delete('schema');
  const connectionString = url.toString();
  return schema === null || schema === '' ? { connectionString } : { connectionString, schema };
}

/**
 * Create a database handle. Does not connect: the pool opens connections on first use, so the
 * API can boot (and report 503 on `/ready`) while the database is still starting.
 */
export function createDb(options: DbOptions): Db {
  const { connectionString, schema } = splitSchema(options.databaseUrl);
  const custom = schema !== undefined && schema !== 'public';
  if (custom && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new Error('DATABASE_URL: the schema parameter must be a plain identifier');
  }

  const adapter = new PrismaPg(
    {
      connectionString,
      connectionTimeoutMillis: options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
      ...(options.maxConnections === undefined ? {} : { max: options.maxConnections }),
      ...(custom ? { options: `-c search_path=${schema}` } : {}),
    },
    {
      ...(custom ? { schema } : {}),
      // Without a listener an error on an idle connection would crash the process.
      onPoolError: options.onPoolError ?? (() => undefined),
    },
  );
  const client = new PrismaClient({ adapter });

  return {
    client,
    async ping() {
      await client.$queryRaw`SELECT 1`;
    },
    async close() {
      await client.$disconnect();
    },
  };
}
