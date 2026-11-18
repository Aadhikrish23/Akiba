import {
  addToLibraryRequestSchema,
  historyQuerySchema,
  episodesTotalRequestSchema,
  progressRequestSchema,
  libraryListQuerySchema,
  updateEntryRequestSchema,
} from '@akiba/shared';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { getAuth } from '../../middleware/auth.js';
import { getValidated, validate } from '../../middleware/validate.js';
import type { HistoryService } from './history.js';
import type { LibraryService } from './library.service.js';

const entryParams = { params: z.object({ entryId: z.string().max(64) }) };

/**
 * Library routes (doc 07 §4). Every one is authenticated, and every query is scoped by the caller's
 * ID taken from the verified token, never from the request: someone else's entry is simply 404.
 * Library data is private to its owner, so nothing is cacheable by a shared cache (`private`).
 */
export function createLibraryRouter(options: {
  readonly service: LibraryService;
  readonly history: HistoryService;
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

  const listSchemas = { query: libraryListQuerySchema };
  router.get('/library', ...guarded, validate(listSchemas), async (_req, res) => {
    res.json(await service.list(getAuth(res).userId, getValidated(res, listSchemas).query));
  });

  router.get('/library/counts', ...guarded, async (_req, res) => {
    res.json({ data: await service.counts(getAuth(res).userId) });
  });

  // Registered before `/library/:entryId` so "favorites" is not read as an entry ID.
  router.get('/library/favorites', ...guarded, validate(listSchemas), async (_req, res) => {
    res.json(await service.favorites(getAuth(res).userId, getValidated(res, listSchemas).query));
  });

  const addSchemas = { body: addToLibraryRequestSchema };
  router.post('/library', ...guarded, validate(addSchemas), async (_req, res) => {
    const entry = await service.add(getAuth(res).userId, getValidated(res, addSchemas).body);
    res.status(201).json({ data: entry });
  });

  router.get('/library/:entryId', ...guarded, validate(entryParams), async (_req, res) => {
    const { params } = getValidated(res, entryParams);
    res.json({ data: await service.get(getAuth(res).userId, params.entryId) });
  });

  const historySchemas = { query: historyQuerySchema };
  router.get('/history', ...guarded, validate(historySchemas), async (_req, res) => {
    res.json(
      await options.history.list(getAuth(res).userId, getValidated(res, historySchemas).query),
    );
  });

  const patchSchemas = { ...entryParams, body: updateEntryRequestSchema };
  router.patch('/library/:entryId', ...guarded, validate(patchSchemas), async (_req, res) => {
    const { params, body } = getValidated(res, patchSchemas);
    res.json({ data: await service.update(getAuth(res).userId, params.entryId, body) });
  });

  const progressSchemas = { ...entryParams, body: progressRequestSchema };
  router.post(
    '/library/:entryId/progress',
    ...guarded,
    validate(progressSchemas),
    async (_req, res) => {
      const { params, body } = getValidated(res, progressSchemas);
      res.json(await service.progress(getAuth(res).userId, params.entryId, body));
    },
  );

  const totalSchemas = { ...entryParams, body: episodesTotalRequestSchema };
  router.put(
    '/library/:entryId/episodes-total',
    ...guarded,
    validate(totalSchemas),
    async (_req, res) => {
      const { params, body } = getValidated(res, totalSchemas);
      res.json({ data: await service.setEpisodesTotal(getAuth(res).userId, params.entryId, body) });
    },
  );

  router.delete(
    '/library/:entryId/episodes-total',
    ...guarded,
    validate(entryParams),
    async (_req, res) => {
      const { params } = getValidated(res, entryParams);
      res.json({ data: await service.clearEpisodesTotal(getAuth(res).userId, params.entryId) });
    },
  );

  router.post('/library/:entryId/runs', ...guarded, validate(entryParams), async (_req, res) => {
    const { params } = getValidated(res, entryParams);
    res.status(201).json({ data: await service.startRun(getAuth(res).userId, params.entryId) });
  });

  router.delete('/library/:entryId', ...guarded, validate(entryParams), async (_req, res) => {
    const { params } = getValidated(res, entryParams);
    await service.remove(getAuth(res).userId, params.entryId);
    res.status(204).end();
  });

  return router;
}
