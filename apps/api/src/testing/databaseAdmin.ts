import pg from 'pg';

/**
 * Admin helpers for the disposable test databases. They only ever create or drop databases
 * whose name starts with `akiba_t_`, so the database named in DATABASE_URL is never touched.
 */
export const TEST_DATABASE_PREFIX = 'akiba_t_';

export function assertTestDatabaseName(name: string): void {
  if (!/^akiba_t_[a-z0-9_]{1,50}$/.test(name)) {
    throw new Error(`refusing to manage a database that is not a test database: ${name}`);
  }
}

/** The same server and credentials as `serverUrl`, but another database. */
export function urlForDatabase(serverUrl: string, database: string): string {
  const url = new URL(serverUrl);
  url.pathname = `/${database}`;
  url.searchParams.delete('schema');
  return url.toString();
}

export async function withAdminClient<T>(
  serverUrl: string,
  run: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const url = new URL(serverUrl);
  url.searchParams.delete('schema');
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

export async function createDatabase(
  serverUrl: string,
  name: string,
  template?: string,
): Promise<void> {
  assertTestDatabaseName(name);
  if (template !== undefined) assertTestDatabaseName(template);
  const statement =
    template === undefined
      ? `CREATE DATABASE "${name}"`
      : `CREATE DATABASE "${name}" TEMPLATE "${template}"`;
  await withAdminClient(serverUrl, async (client) => {
    // Copying a template fails while anything else is connected to it (another worker may be
    // copying it at the same moment), so retry briefly on "object in use".
    for (let attempt = 1; ; attempt++) {
      try {
        await client.query(statement);
        return;
      } catch (error) {
        const inUse = (error as { code?: string }).code === '55006';
        if (!inUse || attempt >= 40) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 100));
      }
    }
  });
}

export async function dropDatabase(serverUrl: string, name: string): Promise<void> {
  assertTestDatabaseName(name);
  await withAdminClient(serverUrl, async (client) => {
    await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  });
}

export async function listDatabases(serverUrl: string, prefix: string): Promise<string[]> {
  return withAdminClient(serverUrl, async (client) => {
    const result = await client.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE starts_with(datname, $1) ORDER BY datname',
      [prefix],
    );
    return result.rows.map((row) => row.datname);
  });
}
