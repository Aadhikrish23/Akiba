/**
 * Result of a database readiness probe. `not_configured` means there is nothing to probe (no
 * `DATABASE_URL`); a probe that cannot reach or query the database rejects.
 */
export type DbCheckResult = 'ok' | 'not_configured';
export type DbCheck = () => Promise<DbCheckResult>;

export const dbNotConfigured: DbCheck = () => Promise.resolve('not_configured');

/**
 * Readiness probe backed by a real query: `ping` is `Db.ping` (`SELECT 1` through the pool), so
 * `ok` means the server is reachable, the credentials work and the database exists. It does not
 * verify that migrations are applied; deploys run `prisma migrate deploy` before starting.
 */
export function createDbCheck(db: { ping(): Promise<void> }): DbCheck {
  return async () => {
    await db.ping();
    return 'ok';
  };
}
