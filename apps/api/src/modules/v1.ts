import { Router } from 'express';

/** The routes served under `/v1`, in the order given (auth first, so its paths are never shadowed). */
export function composeV1(...routers: readonly Router[]): Router {
  const v1 = Router();
  for (const router of routers) v1.use(router);
  return v1;
}
