import { connect } from 'node:net';

/**
 * Result of a database readiness probe. `not_configured` means there is nothing to probe (no
 * `DATABASE_URL`); a probe that cannot reach the database rejects.
 */
export type DbCheckResult = 'ok' | 'not_configured';
export type DbCheck = () => Promise<DbCheckResult>;

export const dbNotConfigured: DbCheck = () => Promise.resolve('not_configured');

/**
 * TEMPORARY (T2): checks only that the database host accepts a TCP connection. It does not
 * authenticate or run a query, so wrong credentials or a missing database still report `ok`.
 * T3 replaces this with a real `SELECT 1` through Prisma; no database client is a dependency yet.
 */
export function createTcpDbCheck(databaseUrl: string, timeoutMs = 1_500): DbCheck {
  const url = new URL(databaseUrl);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = url.port === '' ? 5432 : Number(url.port);

  return () =>
    new Promise<DbCheckResult>((resolve, reject) => {
      const socket = connect({ host, port });
      const finish = (error?: Error): void => {
        socket.destroy();
        if (error) reject(error);
        else resolve('ok');
      };
      socket.setTimeout(timeoutMs, () => {
        finish(new Error('database connection timed out'));
      });
      socket.once('connect', () => {
        finish();
      });
      socket.once('error', (error) => {
        finish(
          new Error(`database unreachable: ${(error as NodeJS.ErrnoException).code ?? 'error'}`),
        );
      });
    });
}
