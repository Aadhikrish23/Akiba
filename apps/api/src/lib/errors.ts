import { PROBLEM_TYPE_BASE } from '../config/constants.js';

/** One field-level validation failure (doc 07 §1). */
export interface FieldError {
  readonly path: string;
  readonly message: string;
}

/** RFC 9457 problem document with Akiba's extension members (doc 07 §1). */
export interface ProblemDocument {
  type: string;
  title: string;
  status: number;
  code: string;
  detail: string;
  errors?: readonly FieldError[];
  requestId: string;
  [extension: string]: unknown;
}

export interface HttpErrorOptions {
  readonly status: number;
  /** Stable machine-readable code, e.g. `VALIDATION_ERROR`. */
  readonly code: string;
  /** Last segment of the problem `type` URI, e.g. `validation`. */
  readonly slug: string;
  readonly title: string;
  /** Safe to show to the client. */
  readonly detail: string;
  readonly errors?: readonly FieldError[];
  readonly headers?: Readonly<Record<string, string>>;
  /** Extra problem members; must not contain internals. */
  readonly extensions?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

/** An error that is safe to render to the client as a problem document. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly slug: string;
  readonly title: string;
  readonly detail: string;
  readonly errors: readonly FieldError[] | undefined;
  readonly headers: Readonly<Record<string, string>>;
  readonly extensions: Readonly<Record<string, unknown>>;

  constructor(options: HttpErrorOptions) {
    super(options.detail, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'HttpError';
    this.status = options.status;
    this.code = options.code;
    this.slug = options.slug;
    this.title = options.title;
    this.detail = options.detail;
    this.errors = options.errors;
    this.headers = options.headers ?? {};
    this.extensions = options.extensions ?? {};
  }
}

export function problemType(slug: string): string {
  return `${PROBLEM_TYPE_BASE}/${slug}`;
}

export function toProblem(error: HttpError, requestId: string): ProblemDocument {
  return {
    ...error.extensions,
    type: problemType(error.slug),
    title: error.title,
    status: error.status,
    code: error.code,
    detail: error.detail,
    ...(error.errors ? { errors: error.errors } : {}),
    requestId,
  };
}

export const notFound = (): HttpError =>
  new HttpError({
    status: 404,
    code: 'NOT_FOUND',
    slug: 'not-found',
    title: 'Not found',
    detail: 'The requested resource does not exist.',
  });

export const malformedRequest = (detail: string, cause?: unknown): HttpError =>
  new HttpError({
    status: 400,
    code: 'MALFORMED_REQUEST',
    slug: 'malformed-request',
    title: 'Malformed request',
    detail,
    cause,
  });

export const payloadTooLarge = (limitBytes: number, cause?: unknown): HttpError =>
  new HttpError({
    status: 413,
    code: 'PAYLOAD_TOO_LARGE',
    slug: 'payload-too-large',
    title: 'Payload too large',
    detail: `The request body exceeds the ${Math.floor(limitBytes / 1024)} KB limit.`,
    cause,
  });

export const validationFailed = (errors: readonly FieldError[]): HttpError =>
  new HttpError({
    status: 422,
    code: 'VALIDATION_ERROR',
    slug: 'validation',
    title: 'Validation failed',
    detail: 'One or more fields are invalid.',
    errors,
  });

export const rateLimited = (retryAfterSeconds: number): HttpError =>
  new HttpError({
    status: 429,
    code: 'RATE_LIMITED',
    slug: 'rate-limited',
    title: 'Too many requests',
    detail: `Rate limit exceeded. Retry in ${retryAfterSeconds} second${retryAfterSeconds === 1 ? '' : 's'}.`,
    headers: { 'Retry-After': String(retryAfterSeconds) },
  });

/**
 * No valid access token. One response for every cause (missing, malformed, forged, expired,
 * revoked session), so a caller learns nothing about why.
 */
export const unauthenticated = (): HttpError =>
  new HttpError({
    status: 401,
    code: 'UNAUTHENTICATED',
    slug: 'unauthenticated',
    title: 'Authentication required',
    detail: 'A valid access token is required.',
    headers: { 'WWW-Authenticate': 'Bearer' },
  });

/** Wrong email or password. Identical for an unknown email and a wrong password (S-AUTH-3). */
export const invalidCredentials = (): HttpError =>
  new HttpError({
    status: 401,
    code: 'INVALID_CREDENTIALS',
    slug: 'invalid-credentials',
    title: 'Invalid credentials',
    detail: 'The email or password is incorrect.',
  });

/** The refresh token is missing, unknown, expired, revoked or reused. One response for all. */
export const invalidRefreshToken = (): HttpError =>
  new HttpError({
    status: 401,
    code: 'INVALID_REFRESH_TOKEN',
    slug: 'invalid-refresh-token',
    title: 'Invalid refresh token',
    detail: 'The session has ended. Sign in again.',
  });

/**
 * A one-time token from an emailed link did not work. One response for every cause (unknown,
 * malformed, wrong purpose, expired, already used, account gone), so a caller learns nothing
 * about which tokens exist or existed (S-AUTH-10).
 */
export const invalidOneTimeToken = (): HttpError =>
  new HttpError({
    status: 400,
    code: 'INVALID_TOKEN',
    slug: 'invalid-token',
    title: 'Invalid or expired link',
    detail: 'This link is invalid, has expired or was already used. Request a new one.',
  });

/**
 * The current password given to confirm a sensitive change was wrong (S-AUTH-11). 403, not 401:
 * the access token is fine, so a client must not treat this as "signed out".
 */
export const reauthenticationFailed = (): HttpError =>
  new HttpError({
    status: 403,
    code: 'REAUTHENTICATION_FAILED',
    slug: 'reauthentication-failed',
    title: 'Current password incorrect',
    detail: 'The current password is incorrect.',
  });

/** The feature needs a verified email address (Q-04) and the caller's is not verified. */
export const emailNotVerified = (): HttpError =>
  new HttpError({
    status: 403,
    code: 'EMAIL_NOT_VERIFIED',
    slug: 'email-not-verified',
    title: 'Email not verified',
    detail: 'Confirm your email address to use this feature.',
  });

/** A browser request to an auth endpoint failed the CSRF checks (S-AUTH-7). */
export const csrfRejected = (): HttpError =>
  new HttpError({
    status: 403,
    code: 'CSRF_REJECTED',
    slug: 'csrf-rejected',
    title: 'Request refused',
    detail: 'The request did not come from an allowed client.',
  });

export const notReady = (checks: Readonly<Record<string, string>>): HttpError =>
  new HttpError({
    status: 503,
    code: 'NOT_READY',
    slug: 'not-ready',
    title: 'Service not ready',
    detail: 'A required dependency is unavailable.',
    extensions: { checks },
  });

/** No metadata source answered and Akiba has no stored copy to serve (FR-DISC-010). */
export const sourcesUnavailable = (): HttpError =>
  new HttpError({
    status: 503,
    code: 'SOURCES_UNAVAILABLE',
    slug: 'sources-unavailable',
    title: 'Catalog temporarily unavailable',
    detail:
      'The anime catalog could not be reached and there is no saved copy of this yet. Try again in a moment.',
    headers: { 'Retry-After': '30' },
  });

export const invalidCursor = (): HttpError => validationFailed([{ path: 'cursor', message: 'is not valid' }]);

export const internalError = (detail = 'An unexpected error occurred.'): HttpError =>
  new HttpError({
    status: 500,
    code: 'INTERNAL_ERROR',
    slug: 'internal',
    title: 'Internal server error',
    detail,
  });
