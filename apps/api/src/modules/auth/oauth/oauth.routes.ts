import {
  oauthLinkRequestSchema,
  oauthProviderParamsSchema,
  oauthSignInRequestSchema,
  oauthStartRequestSchema,
  type LoginResponse,
  type OAuthStartResponse,
  type RefreshResponse,
  type SignInMethodsResponse,
} from '@akiba/shared';
import express, { type Request, type RequestHandler, type Response, type Router } from 'express';
import { z } from 'zod';
import { getAuth } from '../../../middleware/auth.js';
import { getValidated, validate } from '../../../middleware/validate.js';
import type { ClientInfo, Session } from '../auth.service.js';
import type { OAuthService } from './oauth.service.js';

export interface OAuthRoutesOptions {
  readonly service: OAuthService;
  /** CSRF guard of the auth router (Origin allow-list, well-formed `X-Client`). */
  readonly guard: RequestHandler;
  /** `requireAuth` followed by the per-user limiters. */
  readonly authenticated: readonly RequestHandler[];
  /** Put a session's tokens where this client's transport expects them (cookie or body). */
  readonly deliver: (req: Request, res: Response, session: Session) => RefreshResponse;
  readonly clientInfo: (req: Request) => ClientInfo;
}

/** What Apple posts to the relay. Unknown fields (`user`, `id_token`) are dropped unread. */
const appleCallbackSchema = z.object({
  code: z.string().max(2048).optional(),
  state: z.string().max(512).optional(),
  error: z.string().max(128).optional(),
});

/**
 * OAuth routes, added to the `/v1/auth` router (doc 07 §2), so they sit behind the same per-IP
 * limiter and `Cache-Control: no-store` as every other auth route:
 *
 *   GET    /oauth                    sign-in methods of the caller (authenticated)
 *   POST   /oauth/link               link a provider (authenticated)
 *   POST   /oauth/apple/callback     relay for Apple's form_post response (see the service)
 *   POST   /oauth/:provider/start    begin the web flow
 *   POST   /oauth/:provider          sign in: {idToken, nonce} or {code, codeVerifier, redirectUri, state}
 *   DELETE /oauth/:provider          unlink a provider (authenticated)
 *
 * `/oauth/link` is registered before `/oauth/:provider`; the provider parameter is an enum, so
 * no other word reaches a provider handler.
 */
export function addOAuthRoutes(router: Router, options: OAuthRoutesOptions): void {
  const { service, guard, deliver, clientInfo } = options;

  router.get('/oauth', ...options.authenticated, async (_req, res) => {
    const body: SignInMethodsResponse = await service.methods(getAuth(res).userId);
    res.status(200).json(body);
  });

  // Authenticated by the access token (a header a hostile page cannot set), like logout-all.
  const linkSchemas = { body: oauthLinkRequestSchema };
  router.post(
    '/oauth/link',
    guard,
    ...options.authenticated,
    validate(linkSchemas),
    async (_req, res) => {
      const body: SignInMethodsResponse = await service.link(
        getAuth(res),
        getValidated(res, linkSchemas).body,
      );
      res.status(200).json(body);
    },
  );

  // No CSRF guard: this request legitimately comes from appleid.apple.com, carries no
  // credentials of ours and changes nothing. It only turns Apple's POST into a GET of the web
  // app. 303 makes the browser fetch the target with GET.
  const callbackSchemas = { body: appleCallbackSchema };
  router.post(
    '/oauth/apple/callback',
    express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 10 }),
    validate(callbackSchemas),
    (_req, res) => {
      res.redirect(303, service.appleCallbackRedirect(getValidated(res, callbackSchemas).body));
    },
  );

  const startSchemas = { params: oauthProviderParamsSchema, body: oauthStartRequestSchema };
  router.post('/oauth/:provider/start', guard, validate(startSchemas), async (_req, res) => {
    const { params, body: input } = getValidated(res, startSchemas);
    const body: OAuthStartResponse = await service.start(params.provider, input);
    res.status(200).json(body);
  });

  const signInSchemas = { params: oauthProviderParamsSchema, body: oauthSignInRequestSchema };
  router.post('/oauth/:provider', guard, validate(signInSchemas), async (req, res) => {
    const { params, body: credential } = getValidated(res, signInSchemas);
    const session = await service.signIn(params.provider, credential, clientInfo(req));
    const body: LoginResponse = { ...deliver(req, res, session), user: session.user };
    res.status(200).json(body);
  });

  const unlinkSchemas = { params: oauthProviderParamsSchema };
  router.delete(
    '/oauth/:provider',
    guard,
    ...options.authenticated,
    validate(unlinkSchemas),
    async (_req, res) => {
      const body: SignInMethodsResponse = await service.unlink(
        getAuth(res),
        getValidated(res, unlinkSchemas).params.provider,
      );
      res.status(200).json(body);
    },
  );
}
