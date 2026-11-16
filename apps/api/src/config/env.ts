import { z } from 'zod';
import { ARGON2_FLOOR, RATE_LIMIT_DEFAULTS } from './constants.js';

/** Thrown when the process environment is unusable. The message never contains variable values. */
export class EnvError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      ['Invalid environment configuration:', ...issues.map((issue) => `  - ${issue}`)].join('\n'),
    );
    this.name = 'EnvError';
    this.issues = issues;
  }
}

const emptyToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

function integer(options: { min: number; max: number; fallback: number }) {
  const message = `must be an integer between ${options.min} and ${options.max}`;
  return z.preprocess(
    emptyToUndefined,
    z.coerce
      .number({ error: message })
      .int(message)
      .min(options.min, message)
      .max(options.max, message)
      .default(options.fallback),
  );
}

function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
  } catch {
    return false;
  }
}

function isPostgresUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'postgres:' || protocol === 'postgresql:';
  } catch {
    return false;
  }
}

const corsOrigins = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .default('')
    .transform((raw) =>
      raw
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin !== ''),
    )
    .refine((origins) => origins.every(isHttpOrigin), {
      error:
        'must be a comma-separated list of exact http(s) origins such as https://app.example.com (no path, no trailing slash, no wildcard)',
    }),
);

/** An Ed25519 key in JWK form (RFC 8037) with a key ID. `d` is the private part. */
export interface Ed25519Jwk {
  readonly kty: 'OKP';
  readonly crv: 'Ed25519';
  readonly x: string;
  readonly d?: string;
  readonly kid: string;
}

const base64Url = (length: number) =>
  z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${length}}$`), 'is not a 32-byte base64url value');

const jwkShape = {
  kty: z.literal('OKP'),
  crv: z.literal('Ed25519'),
  x: base64Url(43),
  kid: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
};

/**
 * A JWK given as one line of JSON. Every failure produces the same fixed message: the value is a
 * private key and must never be echoed, not even partly.
 */
function jwkJson(kind: 'private' | 'public') {
  const shape =
    kind === 'private'
      ? z.object({ ...jwkShape, d: base64Url(43) })
      : // `strictObject`: a private key pasted into the public slot is refused.
        z.strictObject(jwkShape);
  const message =
    kind === 'private'
      ? 'must be an Ed25519 private key as JWK JSON with kty, crv, x, d and kid (generate one with `pnpm auth:gen-key`)'
      : 'must be an Ed25519 PUBLIC key as JWK JSON with exactly kty, crv, x and kid';
  return z.preprocess(
    emptyToUndefined,
    z
      .string()
      .transform((raw, context): Ed25519Jwk => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = undefined;
        }
        const result = shape.safeParse(parsed);
        if (!result.success) {
          context.addIssue({ code: 'custom', message });
          return z.NEVER;
        }
        return result.data;
      })
      .optional(),
  );
}

const flag = (fallback: boolean) =>
  z.preprocess(
    emptyToUndefined,
    z
      .enum(['true', 'false'], { error: 'must be true or false' })
      .default(fallback ? 'true' : 'false')
      .transform((value) => value === 'true'),
  );

const claimName = (fallback: string) =>
  z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^[\x21-\x7e]{1,128}$/, 'must be 1 to 128 printable ASCII characters without spaces')
      .default(fallback),
  );

const envSchema = z
  .object({
    NODE_ENV: z.preprocess(
      emptyToUndefined,
      z
        .enum(['development', 'test', 'production'], {
          error: 'must be one of development, test, production',
        })
        .default('development'),
    ),
    PORT: integer({ min: 0, max: 65_535, fallback: 3000 }),
    LOG_LEVEL: z.preprocess(
      emptyToUndefined,
      z
        .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'], {
          error: 'must be one of fatal, error, warn, info, debug, trace, silent',
        })
        .default('info'),
    ),
    DATABASE_URL: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .refine(isPostgresUrl, { error: 'must be a postgresql:// connection URL' })
        .optional(),
    ),
    CORS_ORIGINS: corsOrigins,
    API_RATE_LIMIT_WINDOW_MS: integer({
      min: 1_000,
      max: 3_600_000,
      fallback: RATE_LIMIT_DEFAULTS.windowMs,
    }),
    API_RATE_LIMIT_MAX: integer({ min: 1, max: 1_000_000, fallback: RATE_LIMIT_DEFAULTS.readMax }),
    API_RATE_LIMIT_WRITE_MAX: integer({
      min: 1,
      max: 1_000_000,
      fallback: RATE_LIMIT_DEFAULTS.writeMax,
    }),
    API_RATE_LIMIT_AUTH_MAX: integer({
      min: 1,
      max: 1_000_000,
      fallback: RATE_LIMIT_DEFAULTS.authMax,
    }),
    TRUST_PROXY_HOPS: integer({ min: 0, max: 10, fallback: 0 }),
    SHUTDOWN_TIMEOUT_MS: integer({ min: 0, max: 120_000, fallback: 10_000 }),
    AUTH_JWT_PRIVATE_JWK: jwkJson('private'),
    AUTH_JWT_PREVIOUS_PUBLIC_JWK: jwkJson('public'),
    AUTH_JWT_ISSUER: claimName('akiba-api'),
    AUTH_JWT_AUDIENCE: claimName('akiba'),
    AUTH_PASSWORD_PEPPER: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .min(32, 'must be at least 32 characters of random data')
        .max(256, 'must be at most 256 characters')
        .optional(),
    ),
    // The floor of doc 09 S-AUTH-1 is the minimum: the environment can only make hashing costlier.
    AUTH_ARGON2_MEMORY_KIB: integer({
      min: ARGON2_FLOOR.memoryKib,
      max: 1_048_576,
      fallback: ARGON2_FLOOR.memoryKib,
    }),
    AUTH_ARGON2_TIME_COST: integer({
      min: ARGON2_FLOOR.timeCost,
      max: 10,
      fallback: ARGON2_FLOOR.timeCost,
    }),
    AUTH_COOKIE_SECURE: flag(true),
    AUTH_HIBP_ENABLED: flag(false),
  })
  .superRefine((env, context) => {
    if (env.NODE_ENV === 'production' && env.AUTH_JWT_PRIVATE_JWK === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['AUTH_JWT_PRIVATE_JWK'],
        message: 'is required when NODE_ENV=production (generate one with `pnpm auth:gen-key`)',
      });
    }
    if (env.NODE_ENV === 'production' && !env.AUTH_COOKIE_SECURE) {
      context.addIssue({
        code: 'custom',
        path: ['AUTH_COOKIE_SECURE'],
        message: 'may be false only when NODE_ENV is development or test',
      });
    }
    if (
      env.AUTH_JWT_PRIVATE_JWK !== undefined &&
      env.AUTH_JWT_PREVIOUS_PUBLIC_JWK?.kid === env.AUTH_JWT_PRIVATE_JWK.kid
    ) {
      context.addIssue({
        code: 'custom',
        path: ['AUTH_JWT_PREVIOUS_PUBLIC_JWK'],
        message: 'must have a different kid than AUTH_JWT_PRIVATE_JWK',
      });
    }
    if (env.NODE_ENV === 'production' && env.DATABASE_URL === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['DATABASE_URL'],
        message: 'is required when NODE_ENV=production',
      });
    }
  });

export type NodeEnv = 'development' | 'test' | 'production';

export interface AuthConfig {
  readonly jwt: {
    readonly issuer: string;
    readonly audience: string;
    /**
     * Current signing key. Absent only outside production, where an ephemeral key is generated
     * at boot (access tokens then do not survive a restart).
     */
    readonly privateJwk: Ed25519Jwk | undefined;
    /** Public half of the key signed with before the last rotation; verification only. */
    readonly previousPublicJwk: Ed25519Jwk | undefined;
  };
  /** Optional secret mixed into every password hash (argon2 `secret` input). */
  readonly passwordPepper: string | undefined;
  readonly argon2: { readonly memoryKib: number; readonly timeCost: number };
  /** `Secure` attribute of the refresh cookie. Always true in production. */
  readonly cookieSecure: boolean;
  /** Also ask the Have I Been Pwned range API about new passwords (off by default). */
  readonly hibpEnabled: boolean;
}

/** Typed, validated runtime configuration. Built once at boot and passed down explicitly. */
export interface AppConfig {
  readonly nodeEnv: NodeEnv;
  readonly port: number;
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  /** Absent only outside production, where `/ready` then reports the database as not configured. */
  readonly databaseUrl: string | undefined;
  /** Exact origins allowed to call the API from a browser. Empty means no cross-origin access. */
  readonly corsOrigins: readonly string[];
  readonly rateLimit: {
    readonly windowMs: number;
    /** Requests per window per client across all routes. */
    readonly max: number;
    /** Requests per window per client for state-changing methods. */
    readonly writeMax: number;
    /** Requests per window per IP across all `/v1/auth` routes (doc 07 §1: 10/min). */
    readonly authMax: number;
  };
  readonly auth: AuthConfig;
  /** Number of reverse-proxy hops to trust for the client IP (0 = use the socket address). */
  readonly trustProxyHops: number;
  readonly shutdownTimeoutMs: number;
}

/**
 * Parse and validate the environment. Fails fast with every problem listed by variable name;
 * values are never echoed because some (DATABASE_URL) contain credentials.
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): AppConfig {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new EnvError(
      result.error.issues.map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`),
    );
  }
  const env = result.data;
  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL,
    corsOrigins: env.CORS_ORIGINS,
    rateLimit: {
      windowMs: env.API_RATE_LIMIT_WINDOW_MS,
      max: env.API_RATE_LIMIT_MAX,
      writeMax: env.API_RATE_LIMIT_WRITE_MAX,
      authMax: env.API_RATE_LIMIT_AUTH_MAX,
    },
    auth: {
      jwt: {
        issuer: env.AUTH_JWT_ISSUER,
        audience: env.AUTH_JWT_AUDIENCE,
        privateJwk: env.AUTH_JWT_PRIVATE_JWK,
        previousPublicJwk: env.AUTH_JWT_PREVIOUS_PUBLIC_JWK,
      },
      passwordPepper: env.AUTH_PASSWORD_PEPPER,
      argon2: { memoryKib: env.AUTH_ARGON2_MEMORY_KIB, timeCost: env.AUTH_ARGON2_TIME_COST },
      cookieSecure: env.AUTH_COOKIE_SECURE,
      hibpEnabled: env.AUTH_HIBP_ENABLED,
    },
    trustProxyHops: env.TRUST_PROXY_HOPS,
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
  };
}
