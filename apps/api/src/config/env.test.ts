import { describe, expect, it } from 'vitest';
import { EnvError, loadEnv } from './env.js';

function failure(env: Record<string, string | undefined>): EnvError {
  try {
    loadEnv(env);
  } catch (error) {
    if (error instanceof EnvError) return error;
    throw error;
  }
  throw new Error('expected loadEnv to throw');
}

describe('loadEnv', () => {
  it('applies documented defaults when nothing is set', () => {
    expect(loadEnv({})).toEqual({
      nodeEnv: 'development',
      port: 3000,
      logLevel: 'info',
      databaseUrl: undefined,
      corsOrigins: [],
      rateLimit: { windowMs: 60_000, max: 600, writeMax: 120 },
      trustProxyHops: 0,
      shutdownTimeoutMs: 10_000,
    });
  });

  it('treats empty strings as unset', () => {
    const config = loadEnv({ PORT: '', CORS_ORIGINS: '  ', DATABASE_URL: '', NODE_ENV: '' });
    expect(config.port).toBe(3000);
    expect(config.corsOrigins).toEqual([]);
    expect(config.databaseUrl).toBeUndefined();
    expect(config.nodeEnv).toBe('development');
  });

  it('parses a full production environment', () => {
    const config = loadEnv({
      NODE_ENV: 'production',
      PORT: '8080',
      LOG_LEVEL: 'warn',
      DATABASE_URL: 'postgresql://akiba:pw@db.internal:5432/akiba',
      CORS_ORIGINS: 'https://app.example.com, http://localhost:5173',
      API_RATE_LIMIT_MAX: '50',
      API_RATE_LIMIT_WRITE_MAX: '5',
      API_RATE_LIMIT_WINDOW_MS: '1000',
      TRUST_PROXY_HOPS: '1',
      SHUTDOWN_TIMEOUT_MS: '0',
    });
    expect(config).toMatchObject({
      nodeEnv: 'production',
      port: 8080,
      logLevel: 'warn',
      corsOrigins: ['https://app.example.com', 'http://localhost:5173'],
      rateLimit: { windowMs: 1000, max: 50, writeMax: 5 },
      trustProxyHops: 1,
      shutdownTimeoutMs: 0,
    });
  });

  it.each([
    ['PORT', 'abc'],
    ['PORT', '70000'],
    ['PORT', '3000.5'],
    ['NODE_ENV', 'staging'],
    ['LOG_LEVEL', 'verbose'],
    ['API_RATE_LIMIT_MAX', '0'],
    ['API_RATE_LIMIT_MAX', '-1'],
    ['API_RATE_LIMIT_WRITE_MAX', 'many'],
    ['API_RATE_LIMIT_WINDOW_MS', '10'],
    ['TRUST_PROXY_HOPS', 'true'],
    ['DATABASE_URL', 'mysql://localhost/akiba'],
    ['DATABASE_URL', 'not a url'],
    ['CORS_ORIGINS', '*'],
    ['CORS_ORIGINS', 'https://app.example.com/'],
    ['CORS_ORIGINS', 'https://app.example.com/path'],
    ['CORS_ORIGINS', 'https://ok.example.com,ftp://files.example.com'],
    ['CORS_ORIGINS', 'app.example.com'],
  ])('rejects %s=%s and names the variable', (name, value) => {
    const error = failure({ [name]: value });
    expect(error.issues).toHaveLength(1);
    expect(error.issues[0]).toMatch(new RegExp(`^${name}: `));
    expect(error.message).toContain('Invalid environment configuration');
  });

  it('requires DATABASE_URL in production', () => {
    expect(failure({ NODE_ENV: 'production' }).issues).toEqual([
      'DATABASE_URL: is required when NODE_ENV=production',
    ]);
  });

  it('reports every problem at once', () => {
    const error = failure({ PORT: 'x', LOG_LEVEL: 'loud', CORS_ORIGINS: '*' });
    expect(error.issues.map((issue) => issue.split(':')[0]).sort()).toEqual([
      'CORS_ORIGINS',
      'LOG_LEVEL',
      'PORT',
    ]);
  });

  it('never echoes values, which may contain credentials', () => {
    const error = failure({
      DATABASE_URL: 'mysql://admin:hunter2-secret@db/akiba',
      PORT: 'port-with-s3cret',
    });
    expect(error.message).not.toContain('hunter2-secret');
    expect(error.message).not.toContain('s3cret');
  });
});
