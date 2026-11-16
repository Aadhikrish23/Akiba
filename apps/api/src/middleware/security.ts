import cors from 'cors';
import type { RequestHandler } from 'express';
import helmet from 'helmet';
import { REQUEST_ID_HEADER } from '../config/constants.js';

/**
 * Security headers for a JSON-only API (doc 09 §4). The API serves no documents, scripts or
 * frames, so the CSP denies everything; HSTS, `X-Content-Type-Options: nosniff` and
 * `Referrer-Policy: no-referrer` are set on every response.
 */
export function securityHeaders(): RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
    xFrameOptions: { action: 'deny' },
    strictTransportSecurity: { maxAge: 15_552_000, includeSubDomains: true },
  });
}

/**
 * CORS allow-list (doc 09 §4). Only exact origins from `CORS_ORIGINS` receive
 * `Access-Control-Allow-Origin` and `Access-Control-Allow-Credentials`; any other origin gets no
 * CORS headers at all, so browsers refuse to expose the response. Requests without an `Origin`
 * header (curl, mobile, server-to-server) are unaffected.
 */
export function corsAllowList(allowedOrigins: readonly string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);
  const handler = cors({
    origin: (origin, callback) => {
      callback(null, origin !== undefined && allowed.has(origin));
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'Idempotency-Key',
      'X-Client',
      REQUEST_ID_HEADER,
    ],
    exposedHeaders: [
      REQUEST_ID_HEADER,
      'Retry-After',
      'RateLimit-Limit',
      'RateLimit-Remaining',
      'RateLimit-Reset',
    ],
    maxAge: 600,
  });
  return (req, res, next) => {
    // The response differs by Origin even when the origin is refused; keep caches honest.
    res.vary('Origin');
    handler(req, res, next);
  };
}
