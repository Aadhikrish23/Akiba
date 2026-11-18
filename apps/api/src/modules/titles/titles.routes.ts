import {
  browseQuerySchema,
  searchQuerySchema,
  seasonQuerySchema,
  seasonSchema,
  type GenresResponse,
} from '@akiba/shared';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { getAuth } from '../../middleware/auth.js';
import { getValidated, validate } from '../../middleware/validate.js';
import type { TitlesService } from './titles.service.js';

const titleParams = { params: z.object({ titleId: z.string().max(64) }) };
const seasonParams = {
  params: z.object({ year: z.coerce.number().int().min(1940).max(2100), season: seasonSchema }),
  query: seasonQuerySchema,
};

/**
 * Discovery routes (doc 07 §3). Every one needs a signed-in user, because every title carries the
 * caller's own library status (FR-DISC-007). `no-cache` (not `no-store`): the browser may keep a
 * copy but must revalidate, so a status change shows at once.
 */
export function createTitlesRouter(options: {
  readonly service: TitlesService;
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

  const searchSchemas = { query: searchQuerySchema };
  router.get('/titles/search', ...guarded, validate(searchSchemas), async (_req, res) => {
    res.json(await service.search(getAuth(res).userId, getValidated(res, searchSchemas).query));
  });

  const browseSchemas = { query: browseQuerySchema };
  router.get('/titles/browse', ...guarded, validate(browseSchemas), async (_req, res) => {
    res.json(await service.browse(getAuth(res).userId, getValidated(res, browseSchemas).query));
  });

  const currentSchemas = { query: seasonQuerySchema };
  router.get('/seasons/current', ...guarded, validate(currentSchemas), async (_req, res) => {
    res.json(
      await service.currentSeason(getAuth(res).userId, getValidated(res, currentSchemas).query),
    );
  });

  router.get('/seasons/:year/:season', ...guarded, validate(seasonParams), async (_req, res) => {
    const { params, query } = getValidated(res, seasonParams);
    res.json(await service.season(getAuth(res).userId, params.year, params.season, query));
  });

  router.get('/titles/:titleId', ...guarded, validate(titleParams), async (_req, res) => {
    const { params } = getValidated(res, titleParams);
    res.json(await service.detail(getAuth(res).userId, params.titleId));
  });

  router.get('/titles/:titleId/relations', ...guarded, validate(titleParams), async (_req, res) => {
    const { params } = getValidated(res, titleParams);
    res.json(await service.relations(getAuth(res).userId, params.titleId));
  });

  router.get('/genres', ...guarded, async (_req, res) => {
    const body: GenresResponse = { data: await service.genres() };
    res.json(body);
  });

  return router;
}
