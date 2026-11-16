/** Maximum accepted request body (doc 09 §4). Export/import routes will override it locally. */
export const MAX_BODY_BYTES = 100 * 1024;

/**
 * Base of the problem `type` URI (doc 07 §1 shows `…/errors/validation`). It is a relative
 * reference, which RFC 9457 §3.1.1 permits, because the public API origin is a deployment-phase
 * decision (D-24); it resolves against whatever origin served the response.
 */
export const PROBLEM_TYPE_BASE = '/errors';

/** Header used to accept, generate and return the request correlation ID. */
export const REQUEST_ID_HEADER = 'X-Request-Id';

/** Starting rate limits from doc 07 §1 (per minute). */
export const RATE_LIMIT_DEFAULTS = {
  windowMs: 60_000,
  readMax: 600,
  writeMax: 120,
  authMax: 10,
} as const;

/** How long `/ready` waits for the database check before reporting it unavailable. */
export const READINESS_TIMEOUT_MS = 2_000;
