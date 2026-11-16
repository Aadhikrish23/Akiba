import type { RequestHandler } from 'express';
import type { Logger } from '../lib/logger.js';
import { getRequestLogger } from './requestId.js';

/**
 * One structured line per completed request. Deliberately records only method, path (no query
 * string), status and duration: headers, cookies, query parameters and bodies can carry tokens or
 * personal data and are never logged (doc 05 §9, doc 09 §7).
 */
export function requestLogger(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const startedAt = process.hrtime.bigint();
    const method = req.method;
    const path = req.path;
    res.on('finish', () => {
      const durationMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
      const fields = { method, path, status: res.statusCode, durationMs };
      const log = getRequestLogger(res, logger);
      // Liveness probes arrive every few seconds; keep them out of the default log level.
      if (path === '/health') log.debug(fields, 'request completed');
      else log.info(fields, 'request completed');
    });
    next();
  };
}
