import { studioTitlesQuerySchema } from '@akiba/shared';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { getAuth } from '../../middleware/auth.js';
import { getValidated, validate } from '../../middleware/validate.js';
import type { ExploreService } from './explore.service.js';

const franchiseParams = { params: z.object({ franchiseId: z.string().max(64) }) };
const studioParams = { params: z.object({ studioId: z.string().max(64) }) };
const characterParams = { params: z.object({ characterId: z.string().max(64) }) };

/**
 * Franchise, studio and character routes (doc 07 §3). Signed-in only, because every title carries
 * the caller's own library status; the same `private, no-cache` as discovery so a status change
 * shows at once. (`GET /titles/:titleId/characters` lives with the other title routes.)
 */
export function createExploreRouter(options: {
  readonly service: ExploreService;
  readonly authenticated: readonly RequestHandler[];
}): Router {
  const { service } = options;
  const router = Router();
  const guarded = [
    ...options.authenticated,
    ((_req, res, next) => {
      res.setHeader('Cache-Control', 'private, no-cache');
      next();
    }) satisfies RequestHandler,
  ];

  router.get(
    '/franchises/:franchiseId',
    ...guarded,
    validate(franchiseParams),
    async (_req, res) => {
      const { params } = getValidated(res, franchiseParams);
      res.json(await service.franchise(getAuth(res).userId, params.franchiseId));
    },
  );

  router.get('/studios/:studioId', ...guarded, validate(studioParams), async (_req, res) => {
    const { params } = getValidated(res, studioParams);
    res.json(await service.studio(getAuth(res).userId, params.studioId));
  });

  const studioTitlesSchemas = { ...studioParams, query: studioTitlesQuerySchema };
  router.get(
    '/studios/:studioId/titles',
    ...guarded,
    validate(studioTitlesSchemas),
    async (_req, res) => {
      const { params, query } = getValidated(res, studioTitlesSchemas);
      res.json(await service.studioTitles(getAuth(res).userId, params.studioId, query));
    },
  );

  router.get(
    '/characters/:characterId',
    ...guarded,
    validate(characterParams),
    async (_req, res) => {
      const { params } = getValidated(res, characterParams);
      res.json(await service.character(getAuth(res).userId, params.characterId));
    },
  );

  return router;
}
