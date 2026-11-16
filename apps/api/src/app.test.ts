import { Router } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HttpError } from './lib/errors.js';
import type { RateLimitStore } from './middleware/rateLimit.js';
import { createRateLimiter, MemoryRateLimitStore } from './middleware/rateLimit.js';
import { getValidated, validate } from './middleware/validate.js';
import { buildTestApp, TEST_SIGNING_JWK } from './testing/harness.js';

const PROBLEM_JSON = /^application\/problem\+json/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Routes that exist only in tests, mounted through the same `/v1` seam feature modules will use.
 * The production app has no validated or failing route yet, so these exercise the middleware.
 */
function fixtureRouter(): Router {
  const router = Router();

  const createSchemas = {
    params: z.object({ entryId: z.string().regex(/^[0-9]+$/, 'must be numeric') }),
    query: z.object({ dryRun: z.enum(['true', 'false']).optional() }),
    body: z.strictObject({
      progress: z.number().int().min(0),
      note: z.string().max(20).optional(),
    }),
  };
  router.post('/entries/:entryId/progress', validate(createSchemas), (_req, res) => {
    const input = getValidated(res, createSchemas);
    res.status(201).json({ entryId: input.params.entryId, progress: input.body.progress });
  });

  const listSchemas = { query: z.object({ limit: z.coerce.number().int().min(1).max(100) }) };
  router.get('/entries', validate(listSchemas), (_req, res) => {
    res.json({ limit: getValidated(res, listSchemas).query.limit });
  });

  router.get('/boom', () => {
    throw new Error('db password is hunter2 at /srv/app/secret.ts');
  });
  router.get('/boom-async', async () => {
    await Promise.resolve();
    throw new Error('async failure');
  });
  router.get('/teapot', () => {
    throw new HttpError({
      status: 409,
      code: 'CONFLICT',
      slug: 'conflict',
      title: 'Conflict',
      detail: 'Already exists.',
    });
  });
  router.post('/echo', (req, res) => {
    res.json({ received: req.body as unknown });
  });
  return router;
}

describe('GET /health and GET /ready (doc 07 §7)', () => {
  it('GET /health returns 200 without touching any dependency', async () => {
    let dbCalls = 0;
    const { app } = buildTestApp({
      checkDb: () => {
        dbCalls += 1;
        return Promise.reject(new Error('down'));
      },
    });
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(dbCalls).toBe(0);
  });

  it('GET /ready is 200 and explicit when no database is configured', async () => {
    const { app } = buildTestApp();
    const response = await request(app).get('/ready');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'ready',
      checks: { database: 'not_configured', sources: 'not_configured' },
    });
  });

  it('GET /ready is 200 when the injected database check passes', async () => {
    const { app } = buildTestApp({ checkDb: () => Promise.resolve('ok') });
    const response = await request(app).get('/ready');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ready', checks: { database: 'ok' } });
  });

  it('GET /ready is 503 problem+json when the database check fails, without the reason', async () => {
    const { app, logs } = buildTestApp({
      checkDb: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.5:5432')),
    });
    const response = await request(app).get('/ready');
    expect(response.status).toBe(503);
    expect(response.headers['content-type']).toMatch(PROBLEM_JSON);
    expect(response.body).toMatchObject({
      type: '/errors/not-ready',
      status: 503,
      code: 'NOT_READY',
      checks: { database: 'unavailable', sources: 'not_configured' },
    });
    expect(response.text).not.toContain('10.0.0.5');
    expect(logs.text).toContain('ECONNREFUSED');
  });

  it('health routes are not served under /v1', async () => {
    const { app } = buildTestApp();
    expect((await request(app).get('/v1/health')).status).toBe(404);
  });
});

describe('request IDs (doc 05 §9)', () => {
  it('generates an X-Request-Id when the client sends none', async () => {
    const { app } = buildTestApp();
    const response = await request(app).get('/health');
    expect(response.headers['x-request-id']).toMatch(UUID);
  });

  it('propagates a client X-Request-Id to the response, the problem body and the logs', async () => {
    const { app, logs } = buildTestApp();
    const response = await request(app).get('/nope').set('X-Request-Id', 'client-abc.123');
    expect(response.headers['x-request-id']).toBe('client-abc.123');
    expect((response.body as { requestId: string }).requestId).toBe('client-abc.123');
    const completed = logs.lines.find((line) => line.msg === 'request completed');
    expect(completed).toMatchObject({
      requestId: 'client-abc.123',
      method: 'GET',
      path: '/nope',
      status: 404,
    });
  });

  it.each([['has spaces and "quotes"'], ['x'.repeat(129)], ['line\tbreak']])(
    'replaces an unsafe inbound request ID (%s)',
    async (unsafe) => {
      const { app } = buildTestApp();
      const response = await request(app).get('/health').set('X-Request-Id', unsafe);
      expect(response.headers['x-request-id']).toMatch(UUID);
    },
  );
});

describe('problem details (RFC 9457, doc 07 §1)', () => {
  it('unknown route → 404 problem+json with the documented members', async () => {
    const { app } = buildTestApp();
    const response = await request(app).get('/v1/does-not-exist');
    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toMatch(PROBLEM_JSON);
    expect(response.body).toEqual({
      type: '/errors/not-found',
      title: 'Not found',
      status: 404,
      code: 'NOT_FOUND',
      detail: 'The requested resource does not exist.',
      requestId: response.headers['x-request-id'],
    });
  });

  it('malformed JSON → 400 problem+json that does not echo the body', async () => {
    const { app } = buildTestApp({ v1Router: fixtureRouter() });
    const response = await request(app)
      .post('/v1/echo')
      .set('Content-Type', 'application/json')
      .send('{"password": "leaky-value", ');
    expect(response.status).toBe(400);
    expect(response.headers['content-type']).toMatch(PROBLEM_JSON);
    expect(response.body).toMatchObject({
      type: '/errors/malformed-request',
      status: 400,
      code: 'MALFORMED_REQUEST',
      detail: 'The request body is not valid JSON.',
    });
    expect(response.text).not.toContain('leaky-value');
  });

  it('undecodable URL → 400 problem+json', async () => {
    const { app } = buildTestApp({ v1Router: fixtureRouter() });
    const response = await request(app).post('/v1/entries/%E0%A4%A/progress').send({});
    expect(response.status).toBe(400);
    expect(response.headers['content-type']).toMatch(PROBLEM_JSON);
    expect((response.body as { code: string }).code).toBe('MALFORMED_REQUEST');
  });

  it('invalid body → 422 problem+json with errors[{path,message}]', async () => {
    const { app } = buildTestApp({ v1Router: fixtureRouter() });
    const response = await request(app)
      .post('/v1/entries/42/progress')
      .send({ progress: -1, note: 'x'.repeat(21) });
    expect(response.status).toBe(422);
    expect(response.headers['content-type']).toMatch(PROBLEM_JSON);
    const body = response.body as { errors: { path: string; message: string }[] };
    expect(body).toMatchObject({
      type: '/errors/validation',
      title: 'Validation failed',
      status: 422,
      code: 'VALIDATION_ERROR',
      requestId: response.headers['x-request-id'],
    });
    expect(body.errors.map((error) => error.path).sort()).toEqual(['note', 'progress']);
    for (const error of body.errors) {
      expect(Object.keys(error).sort()).toEqual(['message', 'path']);
      expect(error.message).not.toBe('');
    }
  });

  it('unknown body fields are rejected on a strict write schema (doc 09 §4)', async () => {
    const { app } = buildTestApp({ v1Router: fixtureRouter() });
    const response = await request(app)
      .post('/v1/entries/42/progress')
      .send({ progress: 3, isAdmin: true });
    expect(response.status).toBe(422);
    const body = response.body as { errors: { path: string; message: string }[] };
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]?.message).toContain('isAdmin');
  });

  it('missing body and bad params/query are all reported, with prefixed paths', async () => {
    const { app } = buildTestApp({ v1Router: fixtureRouter() });
    const response = await request(app).post('/v1/entries/abc/progress?dryRun=maybe');
    expect(response.status).toBe(422);
    const body = response.body as { errors: { path: string; message: string }[] };
    expect(body.errors.map((error) => error.path).sort()).toEqual([
      'body',
      'params.entryId',
      'query.dryRun',
    ]);
  });

  it('valid input passes and handlers receive parsed, coerced values', async () => {
    const { app } = buildTestApp({ v1Router: fixtureRouter() });
    const created = await request(app).post('/v1/entries/42/progress').send({ progress: 3 });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ entryId: '42', progress: 3 });

    const listed = await request(app).get('/v1/entries?limit=24');
    expect(listed.body).toEqual({ limit: 24 });
    expect((await request(app).get('/v1/entries?limit=101')).status).toBe(422);
  });

  it('a thrown HttpError is rendered as-is', async () => {
    const { app } = buildTestApp({ v1Router: fixtureRouter() });
    const response = await request(app).get('/v1/teapot');
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ type: '/errors/conflict', code: 'CONFLICT' });
  });

  it('unexpected error → 500 problem+json; production hides message and stack, logs keep them', async () => {
    const { app, logs } = buildTestApp({
      v1Router: fixtureRouter(),
      env: {
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
        AUTH_JWT_PRIVATE_JWK: JSON.stringify(TEST_SIGNING_JWK),
      },
    });
    const response = await request(app).get('/v1/boom');
    expect(response.status).toBe(500);
    expect(response.headers['content-type']).toMatch(PROBLEM_JSON);
    expect(response.body).toEqual({
      type: '/errors/internal',
      title: 'Internal server error',
      status: 500,
      code: 'INTERNAL_ERROR',
      detail: 'An unexpected error occurred.',
      requestId: response.headers['x-request-id'],
    });
    expect(response.text).not.toMatch(/hunter2|secret\.ts|app\.test|at .+:\d+:\d+|stack/);

    const failed = logs.lines.find((line) => line.msg === 'request failed');
    expect(failed).toMatchObject({ level: 50, requestId: response.headers['x-request-id'] });
    expect((failed?.err as { stack: string }).stack).toContain('app.test');
  });

  it('errors from async handlers are handled too', async () => {
    const { app } = buildTestApp({ v1Router: fixtureRouter() });
    const response = await request(app).get('/v1/boom-async');
    expect(response.status).toBe(500);
    expect(response.headers['content-type']).toMatch(PROBLEM_JSON);
  });

  it('outside production the 500 detail carries the message but never a stack', async () => {
    const { app } = buildTestApp({ v1Router: fixtureRouter() });
    const response = await request(app).get('/v1/boom-async');
    expect((response.body as { detail: string }).detail).toBe('async failure');
    expect(response.text).not.toMatch(/at .+:\d+:\d+/);
    expect(response.body).not.toHaveProperty('stack');
  });
});

describe('body size limit (doc 09 §4: max body 100 KB)', () => {
  it('accepts a body just under the limit', async () => {
    const { app } = buildTestApp({ v1Router: fixtureRouter() });
    const response = await request(app)
      .post('/v1/echo')
      .send({ blob: 'a'.repeat(99 * 1024) });
    expect(response.status).toBe(200);
  });

  it('rejects a body over the limit with 413 problem+json', async () => {
    const { app } = buildTestApp({ v1Router: fixtureRouter() });
    const response = await request(app)
      .post('/v1/echo')
      .send({ blob: 'a'.repeat(101 * 1024) });
    expect(response.status).toBe(413);
    expect(response.headers['content-type']).toMatch(PROBLEM_JSON);
    expect(response.body).toMatchObject({
      type: '/errors/payload-too-large',
      code: 'PAYLOAD_TOO_LARGE',
      detail: 'The request body exceeds the 100 KB limit.',
    });
  });
});

describe('NFR-SEC-005 rate limiting', () => {
  it('returns 429 problem+json with Retry-After once the per-IP limit is exceeded', async () => {
    const { app } = buildTestApp({ env: { API_RATE_LIMIT_MAX: '3' } });
    for (let i = 0; i < 3; i += 1) {
      const allowed = await request(app).get('/ready');
      expect(allowed.status).toBe(200);
      expect(allowed.headers['ratelimit-limit']).toBe('3');
      expect(allowed.headers['ratelimit-remaining']).toBe(String(2 - i));
    }
    const limited = await request(app).get('/ready');
    expect(limited.status).toBe(429);
    expect(limited.headers['content-type']).toMatch(PROBLEM_JSON);
    const retryAfter = Number(limited.headers['retry-after']);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(limited.body).toMatchObject({
      type: '/errors/rate-limited',
      status: 429,
      code: 'RATE_LIMITED',
      requestId: limited.headers['x-request-id'],
    });
  });

  it('also limits unknown routes, and never throttles the liveness probe', async () => {
    const { app } = buildTestApp({ env: { API_RATE_LIMIT_MAX: '1' } });
    expect((await request(app).get('/v1/missing')).status).toBe(404);
    expect((await request(app).get('/v1/missing')).status).toBe(429);
    for (let i = 0; i < 5; i += 1) {
      expect((await request(app).get('/health')).status).toBe(200);
    }
  });

  it('applies the stricter write budget to state-changing methods only', async () => {
    const { app } = buildTestApp({
      v1Router: fixtureRouter(),
      env: { API_RATE_LIMIT_MAX: '100', API_RATE_LIMIT_WRITE_MAX: '2' },
    });
    expect((await request(app).post('/v1/echo').send({})).status).toBe(200);
    expect((await request(app).post('/v1/echo').send({})).status).toBe(200);
    const limited = await request(app).post('/v1/echo').send({});
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect((await request(app).get('/ready')).status).toBe(200);
  });

  it('rejects before reading the body, so an over-limit client cannot make the server parse', async () => {
    const { app } = buildTestApp({ v1Router: fixtureRouter(), env: { API_RATE_LIMIT_MAX: '1' } });
    await request(app).get('/ready');
    const response = await request(app)
      .post('/v1/echo')
      .set('Content-Type', 'application/json')
      .send('{not json');
    expect(response.status).toBe(429);
  });

  it('budgets are per client IP (via the trusted proxy hop)', async () => {
    const { app } = buildTestApp({ env: { API_RATE_LIMIT_MAX: '1', TRUST_PROXY_HOPS: '1' } });
    expect((await request(app).get('/ready').set('X-Forwarded-For', '203.0.113.1')).status).toBe(
      200,
    );
    expect((await request(app).get('/ready').set('X-Forwarded-For', '203.0.113.1')).status).toBe(
      429,
    );
    expect((await request(app).get('/ready').set('X-Forwarded-For', '203.0.113.2')).status).toBe(
      200,
    );
  });

  it('ignores X-Forwarded-For when no proxy is trusted, so the header cannot dodge the limit', async () => {
    const { app } = buildTestApp({ env: { API_RATE_LIMIT_MAX: '1' } });
    expect((await request(app).get('/ready').set('X-Forwarded-For', '203.0.113.1')).status).toBe(
      200,
    );
    expect((await request(app).get('/ready').set('X-Forwarded-For', '203.0.113.2')).status).toBe(
      429,
    );
  });

  it('factory builds an independent stricter limiter (10/min/IP for auth in T4) and resets after the window', async () => {
    let now = 1_000_000;
    const router = Router();
    router.post(
      '/auth/login',
      createRateLimiter({
        name: 'auth',
        windowMs: 60_000,
        max: 10,
        store: new MemoryRateLimitStore(),
        now: () => now,
      }),
      (_req, res) => {
        res.status(204).end();
      },
    );
    const { app } = buildTestApp({ v1Router: router });

    for (let i = 0; i < 10; i += 1) {
      expect((await request(app).post('/v1/auth/login')).status).toBe(204);
    }
    now += 15_000;
    const limited = await request(app).post('/v1/auth/login');
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('45');

    now += 45_000;
    expect((await request(app).post('/v1/auth/login')).status).toBe(204);
  });

  it('uses the injected store, and a failing store fails closed with 500', async () => {
    const keys: string[] = [];
    const recording: RateLimitStore = {
      hit: (key, windowMs, now) => {
        keys.push(key);
        return Promise.resolve({ count: 1, resetAt: now + windowMs });
      },
    };
    const ok = buildTestApp({ rateLimitStore: recording });
    expect((await request(ok.app).get('/ready')).status).toBe(200);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^global:/);

    const broken = buildTestApp({
      rateLimitStore: { hit: () => Promise.reject(new Error('store offline')) },
    });
    expect((await request(broken.app).get('/ready')).status).toBe(500);
  });
});

describe('CORS allow-list (doc 09 §4)', () => {
  const env = { CORS_ORIGINS: 'https://app.akiba.test,http://localhost:5173' };

  it('allows a listed origin, with credentials', async () => {
    const { app } = buildTestApp({ env });
    const response = await request(app).get('/health').set('Origin', 'https://app.akiba.test');
    expect(response.headers['access-control-allow-origin']).toBe('https://app.akiba.test');
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(response.headers['access-control-expose-headers']).toContain('X-Request-Id');
    expect(response.headers.vary).toContain('Origin');
  });

  it.each([
    ['https://evil.example'],
    ['https://app.akiba.test.evil.example'],
    ['http://app.akiba.test'],
    ['null'],
  ])('sends no CORS headers (and no credentials) to unlisted origin %s', async (origin) => {
    const { app } = buildTestApp({ env });
    const response = await request(app).get('/health').set('Origin', origin);
    expect(response.status).toBe(200);
    expect(response.headers).not.toHaveProperty('access-control-allow-origin');
    expect(response.headers).not.toHaveProperty('access-control-allow-credentials');
    expect(response.headers.vary).toContain('Origin');
  });

  it('answers a preflight from a listed origin', async () => {
    const { app } = buildTestApp({ env });
    const response = await request(app)
      .options('/v1/library')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type');
    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(response.headers['access-control-allow-methods']).toContain('POST');
    expect(response.headers['access-control-allow-headers']).toContain('Authorization');
  });

  it('refuses a preflight from an unlisted origin', async () => {
    const { app } = buildTestApp({ env });
    const response = await request(app)
      .options('/v1/library')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST');
    expect(response.status).toBe(404);
    expect(response.headers).not.toHaveProperty('access-control-allow-origin');
  });

  it('with no origins configured, no origin is allowed', async () => {
    const { app } = buildTestApp();
    const response = await request(app).get('/health').set('Origin', 'http://localhost:5173');
    expect(response.headers).not.toHaveProperty('access-control-allow-origin');
  });

  it('error responses to a listed origin still carry CORS headers', async () => {
    const { app } = buildTestApp({ env });
    const response = await request(app).get('/v1/missing').set('Origin', 'https://app.akiba.test');
    expect(response.status).toBe(404);
    expect(response.headers['access-control-allow-origin']).toBe('https://app.akiba.test');
  });
});

describe('security headers (doc 09 §4)', () => {
  it('sets a deny-all CSP and the hardening headers on success and error responses', async () => {
    const { app } = buildTestApp();
    for (const path of ['/health', '/v1/missing']) {
      const { headers } = await request(app).get(path);
      expect(headers['content-security-policy']).toBe(
        "default-src 'none';base-uri 'none';form-action 'none';frame-ancestors 'none'",
      );
      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['referrer-policy']).toBe('no-referrer');
      expect(headers['x-frame-options']).toBe('DENY');
      expect(headers['strict-transport-security']).toBe('max-age=15552000; includeSubDomains');
      expect(headers).not.toHaveProperty('x-powered-by');
    }
  });
});

describe('request logging never records credentials (doc 05 §9, doc 09 §7)', () => {
  it('logs method, path and status but no headers, cookies, query string or body', async () => {
    const { app, logs } = buildTestApp({ v1Router: fixtureRouter() });
    await request(app)
      .post('/v1/echo?token=query-s3cret')
      .set('Authorization', 'Bearer header-s3cret')
      .set('Cookie', 'refresh=cookie-s3cret')
      .send({ password: 'body-s3cret' });
    await request(app)
      .post('/v1/entries/1/progress?reset=query-s3cret')
      .set('Authorization', 'Bearer header-s3cret')
      .send({ progress: 'body-s3cret' });

    expect(logs.lines.filter((line) => line.msg === 'request completed')).toHaveLength(2);
    expect(logs.text).not.toContain('s3cret');
    expect(logs.lines[0]).toMatchObject({ method: 'POST', path: '/v1/echo', status: 200 });
  });
});
