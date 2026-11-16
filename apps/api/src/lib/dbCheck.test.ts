import { describe, expect, it, vi } from 'vitest';
import { createDbCheck, dbNotConfigured } from './dbCheck.js';

// The probe against a real PostgreSQL (and /ready on top of it) is tested in src/db/db.test.ts.
describe('database readiness probes', () => {
  it('dbNotConfigured reports not_configured', async () => {
    await expect(dbNotConfigured()).resolves.toBe('not_configured');
  });

  it('createDbCheck pings on every call and reports ok', async () => {
    const ping = vi.fn(() => Promise.resolve());
    const check = createDbCheck({ ping });

    await expect(check()).resolves.toBe('ok');
    await expect(check()).resolves.toBe('ok');
    expect(ping).toHaveBeenCalledTimes(2);
  });

  it('createDbCheck rejects with the ping error', async () => {
    const failure = new Error('connection refused');
    const check = createDbCheck({ ping: () => Promise.reject(failure) });

    await expect(check()).rejects.toBe(failure);
  });
});
