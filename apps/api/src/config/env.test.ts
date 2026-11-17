import { generateKeyPairSync } from 'node:crypto';
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
        oauth: {
          google: { clientIds: [], clientSecret: undefined },
          apple: { clientIds: [], webKey: undefined },
          redirectUris: ['http://localhost:5173/oauth/callback'],
        },
      },
      email: { provider: 'console', devPrintLinks: false, webBaseUrl: 'http://localhost:5173' },
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
      WEB_BASE_URL: 'https://app.example.com',
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

  it('requires DATABASE_URL, a signing key and the web app origin in production', () => {
    expect(failure({ NODE_ENV: 'production' }).issues).toEqual([
      'AUTH_JWT_PRIVATE_JWK: is required when NODE_ENV=production (generate one with `pnpm auth:gen-key`)',
      'WEB_BASE_URL: is required when NODE_ENV=production (emailed links point to it)',
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
        WEB_BASE_URL: 'https://app.example.com',
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

  describe('email settings (T5)', () => {
    const production = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://akiba:pw@db.internal:5432/akiba',
      AUTH_JWT_PRIVATE_JWK: PRIVATE_JWK,
      WEB_BASE_URL: 'https://app.example.com',
    };

    it('FR-AUTH-005/006: the provider defaults to console and an unknown one stops the boot', () => {
      expect(loadEnv({}).email.provider).toBe('console');
      expect(loadEnv({ EMAIL_PROVIDER: 'console' }).email.provider).toBe('console');
      for (const unknown of ['smtp', 'resend', 'Console', 'none']) {
        expect(failure({ EMAIL_PROVIDER: unknown }).issues).toEqual([
          'EMAIL_PROVIDER: must be one of: console',
        ]);
      }
    });

    it('S-AUTH-10: printing links is a development aid that production refuses', () => {
      expect(loadEnv({}).email.devPrintLinks).toBe(false);
      expect(loadEnv({ EMAIL_DEV_PRINT_LINKS: 'true' }).email.devPrintLinks).toBe(true);
      expect(loadEnv({ NODE_ENV: 'test', EMAIL_DEV_PRINT_LINKS: 'true' }).email.devPrintLinks).toBe(
        true,
      );
      expect(loadEnv(production).email.devPrintLinks).toBe(false);
      expect(failure({ ...production, EMAIL_DEV_PRINT_LINKS: 'true' }).issues).toEqual([
        'EMAIL_DEV_PRINT_LINKS: may be true only when NODE_ENV is development or test',
      ]);
    });

    it('WEB_BASE_URL must be an exact origin, and https in production', () => {
      expect(loadEnv({ WEB_BASE_URL: 'http://localhost:4000' }).email.webBaseUrl).toBe(
        'http://localhost:4000',
      );
      expect(loadEnv(production).email.webBaseUrl).toBe('https://app.example.com');
      for (const bad of ['app.example.com', 'https://app.example.com/', 'https://a.example/x']) {
        expect(failure({ WEB_BASE_URL: bad }).issues[0]).toMatch(
          /^WEB_BASE_URL: must be the exact/,
        );
      }
      expect(failure({ ...production, WEB_BASE_URL: 'http://app.example.com' }).issues).toEqual([
        'WEB_BASE_URL: must be an https:// origin when NODE_ENV=production',
      ]);
    });
  });

  describe('OAuth settings (T6, doc 09 S-AUTH-9)', () => {
    // THROWAWAY key generated for this test file only; it is registered nowhere.
    const APPLE_PEM = generateKeyPairSync('ec', { namedCurve: 'P-256' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .trim();
    const production = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://u:p@db.internal:5432/akiba',
      AUTH_JWT_PRIVATE_JWK: PRIVATE_JWK,
      WEB_BASE_URL: 'https://app.akiba.example',
    };

    it('FR-AUTH-002: every provider variable is optional, in production too', () => {
      const config = loadEnv(production);
      expect(config.auth.oauth).toEqual({
        google: { clientIds: [], clientSecret: undefined },
        apple: { clientIds: [], webKey: undefined },
        redirectUris: ['https://app.akiba.example/oauth/callback'],
      });
    });

    it('S-AUTH-9: parses client ID lists, the Google secret, the Apple key and the redirect URIs', () => {
      const { oauth } = loadEnv({
        GOOGLE_CLIENT_IDS: ' web.apps.googleusercontent.com , android.apps.googleusercontent.com ',
        GOOGLE_CLIENT_SECRET: 'throwaway-secret-123',
        APPLE_CLIENT_IDS: 'com.example.web,com.example.app',
        APPLE_TEAM_ID: 'ABCDE12345',
        APPLE_KEY_ID: 'KEY1234567',
        APPLE_PRIVATE_KEY: APPLE_PEM.replace(/\n/g, '\\n'),
        OAUTH_REDIRECT_URIS:
          'https://app.example.com/oauth/callback, http://localhost:5173/oauth/callback',
      }).auth;
      expect(oauth).toEqual({
        google: {
          clientIds: ['web.apps.googleusercontent.com', 'android.apps.googleusercontent.com'],
          clientSecret: 'throwaway-secret-123',
        },
        apple: {
          clientIds: ['com.example.web', 'com.example.app'],
          webKey: { teamId: 'ABCDE12345', keyId: 'KEY1234567', privateKeyPem: APPLE_PEM },
        },
        redirectUris: [
          'https://app.example.com/oauth/callback',
          'http://localhost:5173/oauth/callback',
        ],
      });
    });

    it('S-AUTH-9: refuses malformed or repeated client IDs', () => {
      expect(failure({ GOOGLE_CLIENT_IDS: 'has space' }).issues[0]).toMatch(/^GOOGLE_CLIENT_IDS:/);
      expect(failure({ APPLE_CLIENT_IDS: 'a,a' }).issues[0]).toMatch(/^APPLE_CLIENT_IDS:/);
    });

    it('S-AUTH-9: a secret or key without its client IDs, and a partial Apple key, stop the boot', () => {
      expect(failure({ GOOGLE_CLIENT_SECRET: 'throwaway-secret-123' }).issues[0]).toMatch(
        /^GOOGLE_CLIENT_SECRET: needs GOOGLE_CLIENT_IDS/,
      );
      expect(
        failure({ APPLE_CLIENT_IDS: 'com.example.web', APPLE_TEAM_ID: 'ABCDE12345' }).issues[0],
      ).toMatch(
        /^APPLE_PRIVATE_KEY: APPLE_TEAM_ID, APPLE_KEY_ID and APPLE_PRIVATE_KEY must be set together/,
      );
      expect(
        failure({
          APPLE_TEAM_ID: 'ABCDE12345',
          APPLE_KEY_ID: 'KEY1234567',
          APPLE_PRIVATE_KEY: APPLE_PEM,
        }).issues[0],
      ).toMatch(/^APPLE_CLIENT_IDS: is required/);
      expect(failure({ APPLE_TEAM_ID: 'short' }).issues[0]).toMatch(/^APPLE_TEAM_ID:/);
    });

    it('doc 09 §5: a bad Apple key or Google secret is refused without echoing it', () => {
      const badKey =
        '-----BEGIN RSA PRIVATE KEY-----\nSECRETMATERIAL\n-----END RSA PRIVATE KEY-----';
      const keyError = failure({ APPLE_PRIVATE_KEY: badKey });
      expect(keyError.message).toContain('APPLE_PRIVATE_KEY: must be a PKCS#8 private key');
      expect(keyError.message).not.toContain('SECRETMATERIAL');
      const secretError = failure({
        GOOGLE_CLIENT_IDS: 'a',
        GOOGLE_CLIENT_SECRET: 'has space in it',
      });
      expect(secretError.message).not.toContain('has space in it');
    });

    it('S-AUTH-9: redirect URIs must be https (http for localhost only, never in production), without fragment or credentials', () => {
      for (const value of [
        'http://app.example.com/cb',
        '/oauth/callback',
        'https://app.example.com/cb#frag',
        'https://user:pw@app.example.com/cb',
        'javascript:alert(1)',
        'https://ok.example.com/cb,ftp://x.example.com/cb',
      ]) {
        expect(failure({ OAUTH_REDIRECT_URIS: value }).issues[0], value).toMatch(
          /^OAUTH_REDIRECT_URIS:/,
        );
      }
      expect(
        failure({ ...production, OAUTH_REDIRECT_URIS: 'http://localhost:5173/oauth/callback' })
          .issues,
      ).toEqual(['OAUTH_REDIRECT_URIS: must contain only https:// URLs when NODE_ENV=production']);
    });
  });
});
