import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../app.js';
import type { AppConfig, Ed25519Jwk } from '../config/env.js';
import type { DbClient } from '../db/index.js';
import { createLogger } from '../lib/logger.js';
import { MemoryRateLimitStore } from '../middleware/rateLimit.js';
import { generateSigningJwk } from '../modules/auth/accessTokens.js';
import type { BreachedPasswordChecker } from '../modules/auth/breachedPasswords.js';
import { createAuthModule, type AuthModule } from '../modules/auth/index.js';
import { Argon2idHasher, type PasswordHasher } from '../modules/auth/password.js';
import { LogSink, testConfig } from './harness.js';

/** A clock the test moves by hand. Starts at a fixed instant so runs are reproducible. */
export class TestClock {
  #ms = Date.parse('2026-11-16T12:00:00.000Z');

  readonly now = (): Date => new Date(this.#ms);

  advance(ms: number): void {
    this.#ms += ms;
  }
}

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const DAY = 24 * 60 * MINUTE;

/** The real argon2id hasher (production parameters) that also records how it was used. */
export class RecordingHasher implements PasswordHasher {
  readonly #inner: PasswordHasher;
  /** Every hash produced, in order. The first is always the module's dummy hash (made at start-up). */
  readonly hashed: string[] = [];
  /** Hashes produced for real passwords (everything after the start-up dummy hash). */
  get passwordHashes(): string[] {
    return this.hashed.slice(1);
  }

  get dummyHash(): string | undefined {
    return this.hashed[0];
  }

  /** The stored hash each verification ran against, in call order. */
  readonly verifiedAgainst: string[] = [];

  constructor(inner: PasswordHasher) {
    this.#inner = inner;
  }

  async hash(password: string): Promise<string> {
    const result = await this.#inner.hash(password);
    this.hashed.push(result);
    return result;
  }

  verify(storedHash: string, password: string): Promise<boolean> {
    this.verifiedAgainst.push(storedHash);
    return this.#inner.verify(storedHash, password);
  }
}

/** The browser origin the test API allows (CORS and CSRF allow-list). */
export const WEB_ORIGIN = 'https://app.akiba.test';
export const WEB_HEADERS = { Origin: WEB_ORIGIN, 'X-Client': 'web/1.0.0' } as const;
export const MOBILE_HEADERS = { 'X-Client': 'mobile/1.0.0' } as const;

export interface AuthTestApp {
  readonly app: Express;
  readonly auth: AuthModule;
  readonly config: AppConfig;
  readonly logs: LogSink;
  readonly clock: TestClock;
  readonly hasher: RecordingHasher;
  /** The throwaway signing key of this app (private part included), for forging test tokens. */
  readonly signingJwk: Ed25519Jwk;
}

export interface AuthTestAppOptions {
  readonly db: DbClient;
  readonly env?: Record<string, string>;
  readonly clock?: TestClock;
  readonly breachedPasswords?: BreachedPasswordChecker;
}

/**
 * The real application with the real auth module on a test database. Only the clock, the log
 * sink and the (generated, throwaway) signing key differ from production; password hashing uses
 * the production argon2id parameters. The per-IP budgets are raised so that suites which are not
 * about rate limiting never trip them; the suites that are set their own values through `env`.
 */
export async function buildAuthTestApp(options: AuthTestAppOptions): Promise<AuthTestApp> {
  const signingJwk = await generateSigningJwk();
  const config = testConfig({
    CORS_ORIGINS: WEB_ORIGIN,
    AUTH_JWT_PRIVATE_JWK: JSON.stringify(signingJwk),
    API_RATE_LIMIT_MAX: '100000',
    API_RATE_LIMIT_WRITE_MAX: '100000',
    API_RATE_LIMIT_AUTH_MAX: '100000',
    ...options.env,
  });
  const logs = new LogSink();
  const logger = createLogger({ level: 'debug', destination: logs });
  const clock = options.clock ?? new TestClock();
  const hasher = new RecordingHasher(
    new Argon2idHasher({
      memoryKib: config.auth.argon2.memoryKib,
      timeCost: config.auth.argon2.timeCost,
      pepper: config.auth.passwordPepper,
    }),
  );
  const rateLimitStore = new MemoryRateLimitStore();
  const auth = await createAuthModule({
    config,
    db: options.db,
    logger,
    rateLimitStore,
    now: clock.now,
    hasher,
    ...(options.breachedPasswords === undefined
      ? {}
      : { breachedPasswords: options.breachedPasswords }),
  });
  const app = createApp({ config, logger, rateLimitStore, v1Router: auth.router });
  return { app, auth, config, logs, clock, hasher, signingJwk };
}

export interface Credentials {
  readonly email: string;
  readonly password: string;
}

let userCounter = 0;

/** Fresh credentials; the password passes the policy and is not on the denylist. */
export function newCredentials(label = 'user'): Credentials {
  userCounter += 1;
  return {
    email: `${label}-${userCounter}@example.test`,
    password: `correct horse battery ${userCounter}`,
  };
}

export async function register(app: Express, credentials: Credentials): Promise<void> {
  const response = await request(app)
    .post('/v1/auth/register')
    .send({ ...credentials, displayName: 'Test User' });
  if (response.status !== 201) {
    throw new Error(`register failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
}

/** The raw value of the refresh cookie in a response, or undefined if none was set. */
export function refreshCookieValue(response: request.Response): string | undefined {
  return setCookieLines(response)
    .map((line) => /^akiba_refresh=([^;]*)/.exec(line)?.[1])
    .find((value) => value !== undefined);
}

export function setCookieLines(response: request.Response): string[] {
  const header = response.headers['set-cookie'] as string[] | string | undefined;
  if (header === undefined) return [];
  return Array.isArray(header) ? header : [header];
}

export const cookieHeader = (refreshToken: string): string => `akiba_refresh=${refreshToken}`;

export interface TestSession {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly userId: string;
}

interface LoginBody {
  accessToken: string;
  refreshToken?: string;
  user: { id: string };
}

/** Log in the way a browser does: the refresh token arrives in the cookie. */
export async function loginWeb(app: Express, credentials: Credentials): Promise<TestSession> {
  const response = await request(app).post('/v1/auth/login').set(WEB_HEADERS).send(credentials);
  const refreshToken = refreshCookieValue(response);
  if (response.status !== 200 || refreshToken === undefined) {
    throw new Error(`web login failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  const body = response.body as LoginBody;
  return { accessToken: body.accessToken, refreshToken, userId: body.user.id };
}

/** Log in the way the mobile app does: the refresh token arrives in the JSON body. */
export async function loginMobile(app: Express, credentials: Credentials): Promise<TestSession> {
  const response = await request(app).post('/v1/auth/login').set(MOBILE_HEADERS).send(credentials);
  const body = response.body as LoginBody;
  if (response.status !== 200 || body.refreshToken === undefined) {
    throw new Error(`mobile login failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return { accessToken: body.accessToken, refreshToken: body.refreshToken, userId: body.user.id };
}

export const refreshWeb = (app: Express, refreshToken: string): request.Test =>
  request(app).post('/v1/auth/refresh').set(WEB_HEADERS).set('Cookie', cookieHeader(refreshToken));

export const refreshMobile = (app: Express, refreshToken: string): request.Test =>
  request(app).post('/v1/auth/refresh').set(MOBILE_HEADERS).send({ refreshToken });

export const getMe = (app: Express, accessToken: string): request.Test =>
  request(app).get('/v1/me').set('Authorization', `Bearer ${accessToken}`);
