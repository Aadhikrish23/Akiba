import { describe, expect, it } from 'vitest';
import { TEST_SIGNING_JWK } from '../testing/harness.js';
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

const PRIVATE = TEST_SIGNING_JWK;
const PRIVATE_JWK = JSON.stringify(PRIVATE);
const publicJwk = (kid: string): string =>
  JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: PRIVATE.x, kid });

describe('loadEnv', () => {
  it('applies documented defaults when nothing is set', () => {
    expect(loadEnv({})).toEqual({
      nodeEnv: 'development',
      port: 3000,
      logLevel: 'info',
      databaseUrl: undefined,
      corsOrigins: [],
      rateLimit: { windowMs: 60_000, max: 600, writeMax: 120, authMax: 10 },
      trustProxyHops: 0,
      shutdownTimeoutMs: 10_000,
      auth: {
        jwt: {
          issuer: 'akiba-api',
          audience: 'akiba',
          privateJwk: undefined,
          previousPublicJwk: undefined,
        },
        passwordPepper: undefined,
        argon2: { memoryKib: 19_456, timeCost: 2 },
        cookieSecure: true,
        hibpEnabled: false,
      },
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
      AUTH_JWT_PRIVATE_JWK: PRIVATE_JWK,
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

  it('requires DATABASE_URL and a signing key in production', () => {
    expect(failure({ NODE_ENV: 'production' }).issues).toEqual([
      'AUTH_JWT_PRIVATE_JWK: is required when NODE_ENV=production (generate one with `pnpm auth:gen-key`)',
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

  describe('auth settings (doc 09 §2)', () => {
    it('S-AUTH-5: parses the signing key and the previous public key', () => {
      const config = loadEnv({
        AUTH_JWT_PRIVATE_JWK: PRIVATE_JWK,
        AUTH_JWT_PREVIOUS_PUBLIC_JWK: publicJwk('test-key-0'),
        AUTH_JWT_ISSUER: 'https://api.example.com',
        AUTH_JWT_AUDIENCE: 'akiba-clients',
      });
      expect(config.auth.jwt).toEqual({
        issuer: 'https://api.example.com',
        audience: 'akiba-clients',
        privateJwk: PRIVATE,
        previousPublicJwk: { kty: 'OKP', crv: 'Ed25519', x: PRIVATE.x, kid: 'test-key-0' },
      });
    });

    it.each([
      ['not JSON', 'not json'],
      ['a JSON string', '"abc"'],
      ['a public key only', publicJwk('k')],
      ['an RSA key', JSON.stringify({ kty: 'RSA', n: 'x', e: 'AQAB', d: 'x', kid: 'k' })],
      ['a symmetric key', JSON.stringify({ kty: 'oct', k: PRIVATE.d, kid: 'k' })],
      ['another curve', JSON.stringify({ ...PRIVATE, crv: 'Ed448' })],
      ['no kid', JSON.stringify({ ...PRIVATE, kid: undefined })],
      ['a short private part', JSON.stringify({ ...PRIVATE, d: 'abc' })],
    ])('S-AUTH-5: rejects a signing key that is %s, without echoing it', (_label, value) => {
      const error = failure({ AUTH_JWT_PRIVATE_JWK: value });
      expect(error.issues).toHaveLength(1);
      expect(error.issues[0]).toMatch(/^AUTH_JWT_PRIVATE_JWK: must be an Ed25519 private key/);
      expect(error.message).not.toContain(PRIVATE.d);
      expect(error.message).not.toContain(PRIVATE.x);
    });

    it('S-AUTH-5: refuses a private key in the previous-key slot and a duplicate kid', () => {
      const leaked = failure({ AUTH_JWT_PREVIOUS_PUBLIC_JWK: PRIVATE_JWK });
      expect(leaked.issues[0]).toMatch(
        /^AUTH_JWT_PREVIOUS_PUBLIC_JWK: must be an Ed25519 PUBLIC key/,
      );
      expect(leaked.message).not.toContain(PRIVATE.d);

      const duplicate = failure({
        AUTH_JWT_PRIVATE_JWK: PRIVATE_JWK,
        AUTH_JWT_PREVIOUS_PUBLIC_JWK: publicJwk(PRIVATE.kid),
      });
      expect(duplicate.issues).toEqual([
        'AUTH_JWT_PREVIOUS_PUBLIC_JWK: must have a different kid than AUTH_JWT_PRIVATE_JWK',
      ]);
    });

    it('S-AUTH-1: argon2 parameters can be raised but never set below the floor', () => {
      const raised = loadEnv({ AUTH_ARGON2_MEMORY_KIB: '65536', AUTH_ARGON2_TIME_COST: '3' });
      expect(raised.auth.argon2).toEqual({ memoryKib: 65_536, timeCost: 3 });
      expect(failure({ AUTH_ARGON2_MEMORY_KIB: '19455' }).issues[0]).toMatch(
        /^AUTH_ARGON2_MEMORY_KIB: must be an integer between 19456 and/,
      );
      expect(failure({ AUTH_ARGON2_TIME_COST: '1' }).issues[0]).toMatch(
        /^AUTH_ARGON2_TIME_COST: must be an integer between 2 and/,
      );
    });

    it('S-AUTH-1: the pepper must be long, and is never echoed', () => {
      expect(loadEnv({ AUTH_PASSWORD_PEPPER: 'p'.repeat(32) }).auth.passwordPepper).toBe(
        'p'.repeat(32),
      );
      const error = failure({ AUTH_PASSWORD_PEPPER: 'too-short-pepper' });
      expect(error.issues[0]).toMatch(/^AUTH_PASSWORD_PEPPER: must be at least 32 characters/);
      expect(error.message).not.toContain('too-short-pepper');
    });

    it('S-AUTH-7: the Secure cookie flag can be turned off in development and test only', () => {
      expect(loadEnv({}).auth.cookieSecure).toBe(true);
      expect(
        loadEnv({ NODE_ENV: 'development', AUTH_COOKIE_SECURE: 'false' }).auth.cookieSecure,
      ).toBe(false);
      expect(loadEnv({ NODE_ENV: 'test', AUTH_COOKIE_SECURE: 'false' }).auth.cookieSecure).toBe(
        false,
      );
      const production = {
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://akiba:pw@db.internal:5432/akiba',
        AUTH_JWT_PRIVATE_JWK: PRIVATE_JWK,
      };
      expect(loadEnv(production).auth.cookieSecure).toBe(true);
      expect(failure({ ...production, AUTH_COOKIE_SECURE: 'false' }).issues).toEqual([
        'AUTH_COOKIE_SECURE: may be false only when NODE_ENV is development or test',
      ]);
      expect(failure({ AUTH_COOKIE_SECURE: 'no' }).issues).toEqual([
        'AUTH_COOKIE_SECURE: must be true or false',
      ]);
    });

    it('S-AUTH-2 / S-AUTH-4: the range lookup is off and the auth limit is 10 unless configured', () => {
      expect(loadEnv({}).auth.hibpEnabled).toBe(false);
      expect(loadEnv({ AUTH_HIBP_ENABLED: 'true' }).auth.hibpEnabled).toBe(true);
      expect(loadEnv({ API_RATE_LIMIT_AUTH_MAX: '3' }).rateLimit.authMax).toBe(3);
      expect(failure({ API_RATE_LIMIT_AUTH_MAX: '0' }).issues[0]).toMatch(
        /^API_RATE_LIMIT_AUTH_MAX: /,
      );
    });
  });
});
