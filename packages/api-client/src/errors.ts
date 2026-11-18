import type { FieldError, ProblemDocument } from '@akiba/shared';

/**
 * The API answered with an error status. Carries the RFC 9457 problem document (doc 07 §1) when
 * the body was one, and a synthesised equivalent when it was not (a proxy's HTML 502, an empty
 * body), so callers always branch on `status` and `code` and never have to parse anything.
 */
export class ApiError extends Error {
  readonly status: number;
  /** Stable machine-readable code, e.g. `VALIDATION_ERROR`; `UNEXPECTED_RESPONSE` if not a problem. */
  readonly code: string;
  readonly title: string;
  readonly detail: string;
  /** Field-level failures of a 422. Empty when there are none. */
  readonly errors: readonly FieldError[];
  readonly requestId: string | undefined;
  /** Seconds to wait before retrying, from `Retry-After` (429/503). */
  readonly retryAfterSeconds: number | undefined;
  /** The problem document as received; undefined when the body was not one. */
  readonly problem: ProblemDocument | undefined;

  constructor(options: {
    readonly status: number;
    readonly code: string;
    readonly title: string;
    readonly detail: string;
    readonly errors?: readonly FieldError[] | undefined;
    readonly requestId?: string | undefined;
    readonly retryAfterSeconds?: number | undefined;
    readonly problem?: ProblemDocument | undefined;
  }) {
    super(options.detail);
    this.name = 'ApiError';
    this.status = options.status;
    this.code = options.code;
    this.title = options.title;
    this.detail = options.detail;
    this.errors = options.errors ?? [];
    this.requestId = options.requestId;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.problem = options.problem;
  }
}

/** No answer arrived: offline, DNS, connection reset, or the request timed out. */
export class NetworkError extends Error {
  readonly timedOut: boolean;

  constructor(message: string, options: { readonly timedOut: boolean; readonly cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'NetworkError';
    this.timedOut = options.timedOut;
  }
}

/**
 * The API answered successfully but not in the shape the shared contract promises. This is a bug
 * (client and server out of step), not something a user can fix, so it is its own class.
 */
export class ContractError extends Error {
  readonly path: string;

  constructor(path: string, issues: string, options?: { readonly cause?: unknown }) {
    super(`Response from ${path} does not match the API contract: ${issues}`, options);
    this.name = 'ContractError';
    this.path = path;
  }
}

/** An authenticated call was made, but there is no session and none can be restored. */
export class NotSignedInError extends Error {
  constructor() {
    super('Not signed in');
    this.name = 'NotSignedInError';
  }
}
