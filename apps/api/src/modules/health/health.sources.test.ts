import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createDbCheck } from '../../lib/dbCheck.js';
import { buildTestApp } from '../../testing/harness.js';

const dbOk = createDbCheck({ ping: () => Promise.resolve() });

describe('GET /ready reports the metadata sources (T12, NFR-REL-001)', () => {
  it.each(['ok', 'degraded', 'not_configured'] as const)('reports %s', async (state) => {
    const { app } = buildTestApp({ checkDb: dbOk, checkSources: () => state });
    const response = await request(app).get('/ready');
    // A shut-out primary is not an outage: the fallback and the stored catalog still answer.
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'ready',
      checks: { database: 'ok', sources: state },
    });
  });

  it('says not_configured when nothing reports sources', async () => {
    const { app } = buildTestApp({ checkDb: dbOk });
    const response = await request(app).get('/ready');
    expect((response.body as { checks: { sources: string } }).checks.sources).toBe(
      'not_configured',
    );
  });
});
