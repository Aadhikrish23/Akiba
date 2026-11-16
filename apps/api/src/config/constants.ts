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

/** Token lifetimes (doc 09 S-AUTH-5/6). Fixed by the security spec, so not environment-tunable. */
export const AUTH_LIFETIMES = {
  accessTokenSeconds: 15 * 60,
  /** A refresh token unused for this long is dead (idle timeout). */
  refreshIdleMs: 14 * 24 * 60 * 60 * 1000,
  /** No session outlives this, however often it is refreshed (absolute timeout). */
  refreshAbsoluteMs: 30 * 24 * 60 * 60 * 1000,
} as const;

/** argon2id floor from doc 09 S-AUTH-1 (also the defaults). The environment may only raise them. */
export const ARGON2_FLOOR = { memoryKib: 19_456, timeCost: 2, parallelism: 1 } as const;

/**
 * Per-account login backoff (doc 09 S-AUTH-4): the first `freeAttempts` failures cost nothing,
 * then each further attempt must wait `baseDelayMs * 2^n`, capped at `maxDelayMs`. The cap is what
 * makes the lock temporary: nobody can lock an account out for longer than that.
 */
export const LOGIN_BACKOFF = {
  freeAttempts: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 15 * 60 * 1000,
  /** Failures are forgotten after this long without a new attempt. */
  forgetAfterMs: 30 * 60 * 1000,
  /** Upper bound on tracked accounts (memory); the stalest are dropped first. */
  maxTrackedKeys: 50_000,
} as const;

/** Refresh-token cookie for web/desktop (doc 09 S-AUTH-7). */
export const REFRESH_COOKIE = { name: 'akiba_refresh', path: '/v1/auth' } as const;
