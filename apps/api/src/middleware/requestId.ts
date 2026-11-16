import { randomUUID } from 'node:crypto';
import type { RequestHandler, Response } from 'express';
import { REQUEST_ID_HEADER } from '../config/constants.js';
import type { Logger } from '../lib/logger.js';

/**
 * Inbound IDs are only propagated when they look like an ID. Anything else (too long, spaces,
 * control characters) is replaced, so a client cannot inject content into logs or headers.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Accept the caller's `X-Request-Id` or generate one, echo it on the response, and attach a child
 * logger carrying it. Must be the first middleware so every later log line and error has the ID.
 */
export function requestId(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const inbound = req.get(REQUEST_ID_HEADER);
    const id = inbound !== undefined && SAFE_REQUEST_ID.test(inbound) ? inbound : randomUUID();
    res.locals.requestId = id;
    res.locals.log = logger.child({ requestId: id });
    res.setHeader(REQUEST_ID_HEADER, id);
    next();
  };
}

export function getRequestId(res: Response): string {
  const id: unknown = res.locals.requestId;
  return typeof id === 'string' ? id : 'unknown';
}

/** The request-scoped logger, or the fallback when the request-ID middleware has not run. */
export function getRequestLogger(res: Response, fallback: Logger): Logger {
  const log = res.locals.log as Logger | undefined;
  return log ?? fallback;
}
