import {
  loginRequestSchema,
  logoutRequestSchema,
  refreshRequestSchema,
  registerRequestSchema,
  type LoginResponse,
  type MeResponse,
  type RefreshResponse,
  type RegisterResponse,
} from '@akiba/shared';
import { Router, type Request, type RequestHandler } from 'express';
import { unauthenticated } from '../../lib/errors.js';
import { getAuth } from '../../middleware/auth.js';
import { getValidated, validate } from '../../middleware/validate.js';
import type { AuthService, ClientInfo, Session } from './auth.service.js';
import {
  clearRefreshCookie,
  csrfGuard,
  noStore,
  readRefreshCookie,
  setRefreshCookie,
  transportOf,
} from './transport.js';

export interface AuthRoutesOptions {
  readonly service: AuthService;
  /** Per-IP limiter shared by every `/auth` route (doc 07 §1: 10/min). */
  readonly ipLimiter: RequestHandler;
  /** `requireAuth` followed by the per-user limiters. */
  readonly authenticated: readonly RequestHandler[];
  readonly allowedOrigins: readonly string[];
  readonly cookieSecure: boolean;
  readonly now: () => Date;
}

const clientInfo = (req: Request): ClientInfo => ({ userAgent: req.get('user-agent') });

/**
 * Routes under `/v1/auth` (doc 07 §2). Each one is: per-IP limit → CSRF guard → validation →
 * handler. The handlers only translate between HTTP and {@link AuthService}.
 */
export function createAuthRouter(options: AuthRoutesOptions): Router {
  const { service, cookieSecure, now } = options;
  const router = Router();

  router.use(options.ipLimiter, noStore);
  const guard = csrfGuard({ allowedOrigins: options.allowedOrigins, cookieAuthenticated: false });
  const cookieGuard = csrfGuard({
    allowedOrigins: options.allowedOrigins,
    cookieAuthenticated: true,
  });

  /** Put the session's tokens where this client's transport expects them. */
  const deliver = (req: Request, res: Parameters<RequestHandler>[1], session: Session) => {
    const body: RefreshResponse = {
      accessToken: session.access.token,
      tokenType: 'Bearer',
      expiresIn: session.access.expiresInSeconds,
    };
    if (transportOf(req) === 'body') {
      body.refreshToken = session.refresh.token;
    } else {
      setRefreshCookie(res, session.refresh.token, session.refresh.expiresAt, {
        secure: cookieSecure,
        now: now(),
      });
    }
    return body;
  };

  /** The refresh token from the place this client's transport uses, and only from there. */
  const presentedRefreshToken = (
    req: Request,
    body: { refreshToken?: string | undefined } | undefined,
  ): string | undefined =>
    transportOf(req) === 'body' ? body?.refreshToken : readRefreshCookie(req);

  const registerSchemas = { body: registerRequestSchema };
  router.post('/register', guard, validate(registerSchemas), async (_req, res) => {
    await service.register(getValidated(res, registerSchemas).body);
    const body: RegisterResponse = { status: 'verification_pending' };
    res.status(201).json(body);
  });

  const loginSchemas = { body: loginRequestSchema };
  router.post('/login', guard, validate(loginSchemas), async (req, res) => {
    const session = await service.login(getValidated(res, loginSchemas).body, clientInfo(req));
    const body: LoginResponse = { ...deliver(req, res, session), user: session.user };
    res.status(200).json(body);
  });

  const refreshSchemas = { body: refreshRequestSchema };
  router.post('/refresh', cookieGuard, validate(refreshSchemas), async (req, res) => {
    const presented = presentedRefreshToken(req, getValidated(res, refreshSchemas).body);
    try {
      const session = await service.refresh(presented, clientInfo(req));
      res.status(200).json(deliver(req, res, session));
    } catch (error) {
      // Whatever went wrong, a browser should stop sending the dead cookie.
      if (transportOf(req) === 'cookie') clearRefreshCookie(res, { secure: cookieSecure });
      throw error;
    }
  });

  const logoutSchemas = { body: logoutRequestSchema };
  router.post('/logout', cookieGuard, validate(logoutSchemas), async (req, res) => {
    await service.logout(presentedRefreshToken(req, getValidated(res, logoutSchemas).body));
    if (transportOf(req) === 'cookie') clearRefreshCookie(res, { secure: cookieSecure });
    res.status(204).end();
  });

  // Authenticated by the access token (a header a hostile page cannot set), so no cookie guard.
  router.post('/logout-all', guard, ...options.authenticated, async (req, res) => {
    await service.logoutAll(getAuth(res).userId);
    if (transportOf(req) === 'cookie') clearRefreshCookie(res, { secure: cookieSecure });
    res.status(204).end();
  });

  return router;
}

/** `GET /v1/me`: the authenticated user's identity (T4 scope; the account tasks extend it). */
export function createMeRouter(options: {
  readonly service: AuthService;
  readonly authenticated: readonly RequestHandler[];
}): Router {
  const router = Router();
  router.get('/me', ...options.authenticated, noStore, async (_req, res) => {
    const user = await options.service.getUser(getAuth(res).userId);
    if (user === null) throw unauthenticated();
    const body: MeResponse = user;
    res.status(200).json(body);
  });
  return router;
}
