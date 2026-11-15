import { APP_NAME } from '@akiba/shared';
import express, { type Express } from 'express';

/**
 * Build the Express application without binding a port, so tests can mount it
 * on an ephemeral one. Middleware and routes (`/health`, `/ready`, ...) are
 * added in T2; this placeholder intentionally exposes none.
 */
export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.locals.name = APP_NAME;
  return app;
}
