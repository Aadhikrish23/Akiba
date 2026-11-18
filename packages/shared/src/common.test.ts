import { describe, expect, it } from 'vitest';
import { healthResponseSchema, problemDocumentSchema, readyResponseSchema } from './common.js';

describe('problemDocumentSchema', () => {
  const problem = {
    type: 'https://akiba.example/errors/validation',
    title: 'Validation failed',
    status: 422,
    code: 'VALIDATION_ERROR',
    detail: 'The request body is invalid.',
    errors: [{ path: 'email', message: 'must be a valid email address' }],
    requestId: 'req-1',
  };

  it('accepts the document the API produces', () => {
    expect(problemDocumentSchema.parse(problem)).toEqual(problem);
  });

  it('keeps members it does not know (doc 07 §9: clients ignore, never reject)', () => {
    const parsed = problemDocumentSchema.parse({ ...problem, retryAfterSeconds: 7 });
    expect(parsed['retryAfterSeconds']).toBe(7);
  });

  it('accepts a problem without field errors or a request id', () => {
    const minimal = {
      type: problem.type,
      title: problem.title,
      status: problem.status,
      code: problem.code,
      detail: problem.detail,
    };
    expect(problemDocumentSchema.safeParse(minimal).success).toBe(true);
  });

  it.each(['type', 'title', 'status', 'code', 'detail'])('requires %s', (member) => {
    const broken: Record<string, unknown> = { ...problem };
    delete broken[member];
    expect(problemDocumentSchema.safeParse(broken).success).toBe(false);
  });
});

describe('probe responses', () => {
  it('accepts /health', () => {
    expect(healthResponseSchema.parse({ status: 'ok' })).toEqual({ status: 'ok' });
    expect(healthResponseSchema.safeParse({ status: 'degraded' }).success).toBe(false);
  });

  it('accepts /ready with extra checks the client does not know', () => {
    const body = {
      status: 'ready',
      checks: { database: 'ok', sources: 'not_configured', cache: 'ok' },
    };
    expect(readyResponseSchema.parse(body)).toEqual(body);
  });

  it('rejects /ready when a known check has an unknown state', () => {
    const body = { status: 'ready', checks: { database: 'slow', sources: 'ok' } };
    expect(readyResponseSchema.safeParse(body).success).toBe(false);
  });
});
