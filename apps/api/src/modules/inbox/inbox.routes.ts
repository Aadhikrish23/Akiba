import { inboxQuerySchema } from '@akiba/shared';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { getAuth } from '../../middleware/auth.js';
import { getValidated, validate } from '../../middleware/validate.js';
import type { InboxService } from './inbox.service.js';

const idParams = { params: z.object({ id: z.string().max(64) }) };

/**
 * Inbox routes (doc 07 §5). Signed-in only; private and never cached (a badge must not lag).
 * `/inbox/read-all` and `/inbox/unread-count` are registered before `/inbox/:id/...` so they are
 * never read as an ID.
 */
export function createInboxRouter(options: {
  readonly service: InboxService;
  readonly authenticated: readonly RequestHandler[];
}): Router {
  const { service } = options;
  const router = Router();
  const guarded: RequestHandler[] = [
    ...options.authenticated,
    (_req, res, next) => {
      res.setHeader('Cache-Control', 'private, no-store');
      next();
    },
  ];

  const listSchemas = { query: inboxQuerySchema };
  router.get('/inbox', ...guarded, validate(listSchemas), async (_req, res) => {
    res.json(await service.list(getAuth(res).userId, getValidated(res, listSchemas).query));
  });

  router.get('/inbox/unread-count', ...guarded, async (_req, res) => {
    res.json(await service.unreadCount(getAuth(res).userId));
  });

  router.post('/inbox/read-all', ...guarded, async (_req, res) => {
    res.json(await service.markAllRead(getAuth(res).userId));
  });

  router.post('/inbox/:id/read', ...guarded, validate(idParams), async (_req, res) => {
    const { params } = getValidated(res, idParams);
    res.json(await service.markRead(getAuth(res).userId, params.id));
  });

  router.delete('/inbox/:id', ...guarded, validate(idParams), async (_req, res) => {
    const { params } = getValidated(res, idParams);
    await service.remove(getAuth(res).userId, params.id);
    res.status(204).end();
  });

  return router;
}
