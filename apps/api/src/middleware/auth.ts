import type { RequestHandler, Response } from 'express';
import { unauthenticated } from '../lib/errors.js';
import { createRateLimiter, isWriteRequest, type RateLimitStore } from './rateLimit.js';

/** The authenticated caller. Both IDs come from a verified access token, never from input. */
export interface AuthContext {
  readonly userId: string;
  readonly sessionId: string;
}

/** What the middleware needs from the auth module (doc 09 S-AUTH-12). */
export interface AccessTokenAuthenticator {
  /** Resolve a bearer token to its user and live session, or `null` for any failure. */
  authenticate(accessToken: string): Promise<AuthContext | null>;
}

// RFC 6750 §2.1 with the RFC 7235 token68 character set. A JWT always fits.
const BEARER = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/;
/** Far above any token this API issues; bounds the work spent on garbage. */
const MAX_TOKEN_LENGTH = 4096;

/**
 * Require `Authorization: Bearer <access token>` (doc 07 §1). Every failure is the same 401.
 * On success the caller is available through {@link getAuth}; handlers must take the user ID
 * from there and nowhere else (doc 09 §3).
 */
export function requireAuth(authenticator: AccessTokenAuthenticator): RequestHandler {
  return (req, res, next) => {
    const match = BEARER.exec(req.get('authorization') ?? '');
    const token = match?.[1];
    if (token === undefined || token.length > MAX_TOKEN_LENGTH) {
      next(unauthenticated());
      return;
    }
    authenticator
      .authenticate(token)
      .then((auth) => {
        if (auth === null) {
          next(unauthenticated());
          return;
        }
        res.locals.auth = auth;
        next();
      })
      .catch(next);
  };
}

/** The caller established by {@link requireAuth}. Throws if the route is not protected by it. */
export function getAuth(res: Response): AuthContext {
  const auth = res.locals.auth as AuthContext | undefined;
  if (auth === undefined) {
    throw new Error('getAuth() called on a route without the requireAuth() middleware');
  }
  return auth;
}

export interface UserRateLimitOptions {
  readonly windowMs: number;
  /** Requests per window per user (doc 07 §1: 600/min). */
  readonly max: number;
  /** State-changing requests per window per user (doc 07 §1: 120/min). */
  readonly writeMax: number;
  readonly store: RateLimitStore;
  readonly now?: () => number;
}

/**
 * Per-USER budgets for authenticated routes (doc 07 §1, NFR-SEC-005), in addition to the per-IP
 * budgets applied to every request. Must run after {@link requireAuth}.
 */
export function userRateLimit(options: UserRateLimitOptions): RequestHandler[] {
  const shared = {
    windowMs: options.windowMs,
    store: options.store,
    ...(options.now === undefined ? {} : { now: options.now }),
  };
  return [
    createRateLimiter({
      ...shared,
      name: 'user',
      max: options.max,
      keyGenerator: (req) => getAuth(req.res as Response).userId,
    }),
    createRateLimiter({
      ...shared,
      name: 'user-write',
      max: options.writeMax,
      keyGenerator: (req) => getAuth(req.res as Response).userId,
      skip: (req) => !isWriteRequest(req),
    }),
  ];
}
