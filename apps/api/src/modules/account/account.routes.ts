import {
  deleteAccountRequestSchema,
  putShareRequestSchema,
  sharedListQuerySchema,
  updateProfileRequestSchema,
  type DeleteAccountResponse,
} from '@akiba/shared';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { getAuth } from '../../middleware/auth.js';
import { getValidated, validate } from '../../middleware/validate.js';
import { clearRefreshCookie } from '../auth/transport.js';
import type { AuthService } from '../auth/index.js';
import type { AccountService } from './account.service.js';

const exportQuery = { query: z.strictObject({ format: z.enum(['json', 'csv']).default('json') }) };
const tokenParams = {
  params: z.object({ token: z.string().max(100) }),
  query: sharedListQuerySchema,
};

/**
 * Account routes (doc 07 §6). `/me/*` is private to the signed-in user; `GET /shared/:token` is the
 * one public route, protected by an unguessable token, a per-IP limit and uniform 404s.
 */
export function createAccountRouter(options: {
  readonly service: AccountService;
  readonly auth: AuthService;
  readonly authenticated: readonly RequestHandler[];
  /** Q-04: sharing needs a verified address. */
  readonly verifiedEmail: RequestHandler;
  /** Per-IP limit for the public shared view. */
  readonly publicLimiter: RequestHandler;
  readonly cookieSecure: boolean;
  readonly now: () => Date;
}): Router {
  const { service } = options;
  const router = Router();
  const priv: RequestHandler[] = [
    ...options.authenticated,
    (_req, res, next) => {
      res.setHeader('Cache-Control', 'private, no-store');
      next();
    },
  ];

  const patchSchemas = { body: updateProfileRequestSchema };
  router.patch('/me', ...priv, validate(patchSchemas), async (_req, res) => {
    res.json(
      await service.updateProfile(getAuth(res).userId, getValidated(res, patchSchemas).body),
    );
  });

  // Deleting asks for the password again; the account is gone from the user's side at once and
  // erased after the grace period (FR-ACCT-002).
  const deleteSchemas = { body: deleteAccountRequestSchema };
  router.delete('/me', ...priv, validate(deleteSchemas), async (_req, res) => {
    const { purgeAfter } = await options.auth.deleteAccount(
      getAuth(res).userId,
      getValidated(res, deleteSchemas).body.password,
    );
    clearRefreshCookie(res, { secure: options.cookieSecure });
    const body: DeleteAccountResponse = {
      status: 'deletion_scheduled',
      purgeAfter: purgeAfter.toISOString(),
    };
    res.status(202).json(body);
  });

  router.post('/me/export', ...priv, validate(exportQuery), async (_req, res) => {
    const { format } = getValidated(res, exportQuery).query;
    const day = options.now().toISOString().slice(0, 10);
    const userId = getAuth(res).userId;
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="akiba-library-${day}.csv"`);
      res.send(await service.exportCsv(userId));
      return;
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="akiba-export-${day}.json"`);
    res.send(JSON.stringify(await service.exportJson(userId), null, 2));
  });

  router.get('/me/share', ...priv, async (_req, res) => {
    res.json(await service.getShare(getAuth(res).userId));
  });

  const shareSchemas = { body: putShareRequestSchema };
  router.put(
    '/me/share',
    ...priv,
    options.verifiedEmail,
    validate(shareSchemas),
    async (_req, res) => {
      res.json(
        await service.putShare(getAuth(res).userId, getValidated(res, shareSchemas).body.scope),
      );
    },
  );

  router.delete('/me/share', ...priv, async (_req, res) => {
    await service.revokeShare(getAuth(res).userId);
    res.status(204).end();
  });

  // 🔓 Public. No cookie, no CORS credentials; nothing on the response identifies the owner beyond
  // the display name they chose, and it must not be indexed or leak its address through Referer.
  router.get('/shared/:token', options.publicLimiter, validate(tokenParams), async (_req, res) => {
    const { params, query } = getValidated(res, tokenParams);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.json(await service.sharedList(params.token, query));
  });

  return router;
}
