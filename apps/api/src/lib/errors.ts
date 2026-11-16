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

// ── OAuth sign-in (T6; doc 09 S-AUTH-9) ──

/** This deployment has no client IDs (or, for the web flow, no client secret) for the provider. */
export const oauthProviderNotConfigured = (flow: 'sign-in' | 'web flow'): HttpError =>
  new HttpError({
    status: 501,
    code: 'OAUTH_PROVIDER_NOT_CONFIGURED',
    slug: 'oauth-provider-not-configured',
    title: 'Sign-in provider not available',
    detail:
      flow === 'sign-in'
        ? 'Sign-in with this provider is not set up on this server.'
        : 'Browser sign-in with this provider is not set up on this server.',
  });

/** The provider could not be reached (signing keys or token endpoint). Nothing was decided. */
export const oauthProviderUnavailable = (cause?: unknown): HttpError =>
  new HttpError({
    status: 503,
    code: 'OAUTH_PROVIDER_UNAVAILABLE',
    slug: 'oauth-provider-unavailable',
    title: 'Sign-in provider unavailable',
    detail: 'The sign-in provider could not be reached. Try again shortly.',
    headers: { 'Retry-After': '30' },
    cause,
  });

/**
 * The provider's proof was not accepted. One response for every cause (forged, expired, wrong
 * audience, issuer or nonce, refused code, account in deletion), so a caller learns nothing
 * about which check failed.
 */
export const oauthSignInFailed = (): HttpError =>
  new HttpError({
    status: 401,
    code: 'OAUTH_SIGN_IN_FAILED',
    slug: 'oauth-sign-in-failed',
    title: 'Sign-in failed',
    detail: 'Sign-in with the provider could not be completed. Start again.',
  });

/** `state` is missing, unknown, expired, already used or does not belong to this request. */
export const invalidOAuthState = (): HttpError =>
  new HttpError({
    status: 400,
    code: 'INVALID_OAUTH_STATE',
    slug: 'invalid-oauth-state',
    title: 'Sign-in attempt expired',
    detail: 'This sign-in attempt is invalid, has expired or was already used. Start again.',
  });

/** The provider did not vouch for an email address, so no account is created or matched. */
export const oauthEmailNotVerified = (): HttpError =>
  new HttpError({
    status: 403,
    code: 'OAUTH_EMAIL_NOT_VERIFIED',
    slug: 'oauth-email-not-verified',
    title: 'Email address not confirmed by the provider',
    detail:
      'The sign-in provider did not confirm an email address for this account. Confirm it with the provider and try again.',
  });

/**
 * An account with the provider's (verified) address exists, but nobody has ever proved control
 * of that address to Akiba. It is neither linked nor signed in to (Q-04, pre-registration).
 */
export const accountEmailUnverified = (): HttpError =>
  new HttpError({
    status: 409,
    code: 'ACCOUNT_EMAIL_UNVERIFIED',
    slug: 'account-email-unverified',
    title: 'Account email not confirmed',
    detail:
      'An account with this email address exists, but the address was never confirmed. Reset its password to take control of it, then sign in with the provider again.',
  });

export const oauthIdentityInUse = (): HttpError =>
  new HttpError({
    status: 409,
    code: 'OAUTH_IDENTITY_IN_USE',
    slug: 'oauth-identity-in-use',
    title: 'Provider account already in use',
    detail: 'This provider account is already linked to a different user.',
  });

export const oauthProviderAlreadyLinked = (): HttpError =>
  new HttpError({
    status: 409,
    code: 'OAUTH_PROVIDER_ALREADY_LINKED',
    slug: 'oauth-provider-already-linked',
    title: 'Provider already linked',
    detail: 'This user is already linked to a different account of this provider. Unlink it first.',
  });

/** Unlinking would leave the account with no way to sign in (FR-AUTH-007). */
export const lastSignInMethod = (): HttpError =>
  new HttpError({
    status: 409,
    code: 'LAST_SIGN_IN_METHOD',
    slug: 'last-sign-in-method',
    title: 'Last sign-in method',
    detail:
      'This is the only way to sign in to the account. Set a password or link another provider first.',
  });

/** A sensitive change on an account without a password needs a fresh sign-in (S-AUTH-11). */
export const reauthenticationRequired = (): HttpError =>
  new HttpError({
    status: 403,
    code: 'REAUTHENTICATION_REQUIRED',
    slug: 'reauthentication-required',
    title: 'Sign in again',
    detail: 'Sign in again, then repeat this change within a few minutes.',
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

export const internalError = (detail = 'An unexpected error occurred.'): HttpError =>
  new HttpError({
    status: 500,
    code: 'INTERNAL_ERROR',
    slug: 'internal',
    title: 'Internal server error',
    detail,
  });
