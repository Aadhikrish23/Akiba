import { CLIENT_HEADER, CLIENT_HEADER_PATTERN } from '@akiba/shared';
import { parseCookie } from 'cookie';
import type { CookieOptions, Request, RequestHandler, Response } from 'express';
import { REFRESH_COOKIE } from '../../config/constants.js';
import { csrfRejected } from '../../lib/errors.js';

/**
 * How the refresh token travels (doc 09 S-AUTH-7/8).
 *
 * - `cookie`: browsers (web, desktop renderer). The token lives in an HttpOnly cookie that
 *   scripts cannot read; it is never put in a response body and never read from a request body.
 * - `body`: the mobile app, announced by `X-Client: mobile/<version>`. The token is returned in
 *   and read from JSON (the app keeps it in the OS keystore); no cookie is set or read.
 */
export type Transport = 'cookie' | 'body';

export type ClientKind = 'web' | 'desktop' | 'mobile' | 'unspecified' | 'invalid';

export function clientKind(req: Request): ClientKind {
  const header = req.get(CLIENT_HEADER);
  if (header === undefined) return 'unspecified';
  const match = CLIENT_HEADER_PATTERN.exec(header);
  return match === null ? 'invalid' : (match[1] as 'web' | 'desktop' | 'mobile');
}

export const transportOf = (req: Request): Transport =>
  clientKind(req) === 'mobile' ? 'body' : 'cookie';

function originOf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

/**
 * CSRF defence for the auth routes (doc 09 S-AUTH-7). A refresh cookie is ambient authority: the
 * browser attaches it to any request to `/v1/auth`, including ones a hostile page triggers.
 * `SameSite=Lax` already keeps it off cross-site POSTs; these checks do not rely on that alone.
 *
 * For every auth request:
 *   1. An `X-Client` header that is present must be well-formed.
 *   2. An `Origin` header that is present must be on the CORS allow-list, except for mobile
 *      clients, which use no cookies. (Browsers always send `Origin` on cross-origin POSTs.)
 *
 * For routes that act on the cookie (`cookieAuthenticated`: refresh, logout), when the transport
 * is the cookie:
 *   3. `X-Client: web/…` or `desktop/…` is REQUIRED. A custom header cannot be sent by a form
 *      or a simple cross-origin request; it forces a CORS preflight, which only allow-listed
 *      origins pass.
 *   4. The origin is REQUIRED: `Origin`, or failing that the origin of `Referer`, must be on the
 *      allow-list. A request with neither is refused.
 */
export function csrfGuard(options: {
  readonly allowedOrigins: readonly string[];
  readonly cookieAuthenticated: boolean;
}): RequestHandler {
  const allowed = new Set(options.allowedOrigins);
  return (req, _res, next) => {
    const kind = clientKind(req);
    if (kind === 'invalid') {
      next(csrfRejected());
      return;
    }
    if (kind === 'mobile') {
      next();
      return;
    }
    const originHeader = req.get('origin');
    if (originHeader !== undefined && !allowed.has(originHeader)) {
      next(csrfRejected());
      return;
    }
    if (options.cookieAuthenticated) {
      const origin = originHeader ?? originOf(req.get('referer'));
      if (kind === 'unspecified' || origin === undefined || !allowed.has(origin)) {
        next(csrfRejected());
        return;
      }
    }
    next();
  };
}

function cookieOptions(secure: boolean): CookieOptions {
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: REFRESH_COOKIE.path,
  };
}

/** Store the refresh token in the browser until its idle deadline. */
export function setRefreshCookie(
  res: Response,
  token: string,
  expiresAt: Date,
  options: { secure: boolean; now: Date },
): void {
  res.cookie(REFRESH_COOKIE.name, token, {
    ...cookieOptions(options.secure),
    maxAge: Math.max(0, expiresAt.getTime() - options.now.getTime()),
  });
}

export function clearRefreshCookie(res: Response, options: { secure: boolean }): void {
  res.clearCookie(REFRESH_COOKIE.name, cookieOptions(options.secure));
}

export function readRefreshCookie(req: Request): string | undefined {
  const header = req.get('cookie');
  if (header === undefined) return undefined;
  const value = parseCookie(header)[REFRESH_COOKIE.name];
  return value === undefined || value === '' ? undefined : value;
}

/** Tell caches and proxies never to keep a response that carries tokens. */
export const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};
