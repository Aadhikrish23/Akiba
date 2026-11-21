import { Router } from 'express';
import { READINESS_TIMEOUT_MS } from '../../config/constants.js';
import type { DbCheck, DbCheckResult } from '../../lib/dbCheck.js';
import { notReady } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import { getRequestLogger } from '../../middleware/requestId.js';

export interface HealthRouterOptions {
  readonly checkDb: DbCheck;
  readonly logger: Logger;
  readonly timeoutMs?: number;
  /** State of the metadata sources: `degraded` = the primary is shut out (fallback in use). */
  readonly checkSources?: () => 'ok' | 'degraded' | 'not_configured';
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('readiness check timed out'));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Operational endpoints (doc 07 §7), mounted at the root rather than under `/v1`.
 *
 * - `GET /health`: liveness. Touches no dependency, so it stays 200 while the database is down.
 * - `GET /ready`: readiness. 200 when the database check passes (or reports `not_configured`),
 *   503 problem+json when it fails. Source-adapter status is reported as `not_configured` until
 *   the adapters exist (T8).
 */
export function createHealthRouter(options: HealthRouterOptions): Router {
  const router = Router();
  const timeoutMs = options.timeoutMs ?? READINESS_TIMEOUT_MS;

  router.get('/health', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ status: 'ok' });
  });

  router.get('/ready', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    let database: DbCheckResult | 'unavailable';
    try {
      database = await withTimeout(options.checkDb(), timeoutMs);
    } catch (error) {
      // The reason stays in the server log; the response only says which check failed.
      getRequestLogger(res, options.logger).warn(
        { err: error },
        'readiness: database check failed',
      );
      database = 'unavailable';
    }
    const sources = options.checkSources?.() ?? 'not_configured';
    const checks = { database, sources } as const;
    if (database === 'unavailable') {
      throw notReady(checks);
    }
    res.json({ status: 'ready', checks });
  });

  return router;
}
