import type { ErrorRequestHandler, RequestHandler, Response } from 'express';
import { MAX_BODY_BYTES } from '../config/constants.js';
import type { NodeEnv } from '../config/env.js';
import {
  HttpError,
  internalError,
  malformedRequest,
  notFound,
  payloadTooLarge,
  toProblem,
} from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { getRequestId, getRequestLogger } from './requestId.js';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** Terminal middleware for requests no route handled. */
export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(notFound());
};

function clientErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { status, statusCode } = error as { status?: unknown; statusCode?: unknown };
  const value = typeof status === 'number' ? status : statusCode;
  return typeof value === 'number' && value >= 400 && value < 500 ? value : undefined;
}

/**
 * Map anything thrown to an `HttpError`. Errors raised by Express and body-parser carry a 4xx
 * `status` (invalid JSON, oversized body, undecodable URL); their messages can quote request
 * content, so a fixed detail is used instead. Everything else is an unexpected failure.
 */
function normalise(error: unknown, nodeEnv: NodeEnv): HttpError {
  if (error instanceof HttpError) return error;

  const status = clientErrorStatus(error);
  if (status === 413) return payloadTooLarge(MAX_BODY_BYTES, error);
  if (status === 415) {
    return new HttpError({
      status: 415,
      code: 'UNSUPPORTED_MEDIA_TYPE',
      slug: 'unsupported-media-type',
      title: 'Unsupported media type',
      detail: 'The request body encoding or charset is not supported.',
      cause: error,
    });
  }
  if (status !== undefined) {
    const type = (error as { type?: unknown }).type;
    return malformedRequest(
      type === 'entity.parse.failed'
        ? 'The request body is not valid JSON.'
        : 'The request could not be parsed.',
      error,
    );
  }

  // Outside production the message helps local debugging. Stack traces are never sent.
  if (nodeEnv !== 'production' && error instanceof Error && error.message !== '') {
    return internalError(error.message);
  }
  return internalError();
}

export function sendProblem(res: Response, error: HttpError): void {
  for (const [name, value] of Object.entries(error.headers)) {
    res.setHeader(name, value);
  }
  res
    .status(error.status)
    .type(PROBLEM_CONTENT_TYPE)
    .json(toProblem(error, getRequestId(res)));
}

/** Final error handler: every failure leaves as an RFC 9457 problem document (doc 07 §1). */
export function errorHandler(options: { logger: Logger; nodeEnv: NodeEnv }): ErrorRequestHandler {
  return (error: unknown, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const httpError = normalise(error, options.nodeEnv);
    const log = getRequestLogger(res, options.logger);
    if (httpError.status >= 500) {
      // Full error (with stack) goes to the server log only.
      log.error({ err: error, code: httpError.code }, 'request failed');
    } else {
      log.debug({ code: httpError.code, status: httpError.status }, 'request rejected');
    }
    sendProblem(res, httpError);
  };
}
