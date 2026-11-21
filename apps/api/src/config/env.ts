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

/** Email delivery providers the API knows. The real one is an open decision. */
export const EMAIL_PROVIDERS = ['console'] as const;
export type EmailProvider = (typeof EMAIL_PROVIDERS)[number];

/** Where emailed links point when `WEB_BASE_URL` is unset (development and test only). */
export const DEV_WEB_BASE_URL = 'http://localhost:5173';

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

/** An optional absolute http(s) URL (a path is allowed: Jikan lives under /v4). */
function httpUrlOption() {
  return z.preprocess(
    emptyToUndefined,
    z
      .string()
      .refine(
        (value) => {
          try {
            const { protocol } = new URL(value);
            return protocol === 'http:' || protocol === 'https:';
          } catch {
            return false;
          }
        },
        { error: 'must be an absolute http(s) URL' },
      )
      .optional(),
  );
}

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
    // `console` is the only provider so far; anything else stops the boot instead of silently
    // dropping verification and reset emails.
    EMAIL_PROVIDER: z.preprocess(
      emptyToUndefined,
      z
        .enum(EMAIL_PROVIDERS, { error: `must be one of: ${EMAIL_PROVIDERS.join(', ')}` })
        .default('console'),
    ),
    EMAIL_DEV_PRINT_LINKS: flag(false),
    // Metadata sources (T12). Defaults are the public services; override for a proxy or a mock.
    SOURCE_ANILIST_URL: httpUrlOption(),
    SOURCE_JIKAN_URL: httpUrlOption(),
    SOURCE_TIMEOUT_MS: integer({ min: 500, max: 30_000, fallback: 5_000 }),
    // Background jobs (airing sync, inbox, cleanup). Unset = on in production, off elsewhere, so a
    // development server or a test never calls the metadata sources on a timer.
    JOBS_ENABLED: z.preprocess(
      emptyToUndefined,
      z
        .enum(['true', 'false'], { error: 'must be true or false' })
        .optional()
        .transform((value) => (value === undefined ? undefined : value === 'true')),
    ),
    WEB_BASE_URL: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .refine(isHttpOrigin, {
          error:
            'must be the exact http(s) origin of the web app such as https://app.example.com (no path, no trailing slash)',
        })
        .optional(),
    ),
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
    if (env.NODE_ENV === 'production' && env.EMAIL_DEV_PRINT_LINKS) {
      context.addIssue({
        code: 'custom',
        path: ['EMAIL_DEV_PRINT_LINKS'],
        message: 'may be true only when NODE_ENV is development or test',
      });
    }
    if (env.NODE_ENV === 'production') {
      if (env.WEB_BASE_URL === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['WEB_BASE_URL'],
          message: 'is required when NODE_ENV=production (emailed links point to it)',
        });
      } else if (!env.WEB_BASE_URL.startsWith('https://')) {
        context.addIssue({
          code: 'custom',
          path: ['WEB_BASE_URL'],
          message: 'must be an https:// origin when NODE_ENV=production',
        });
      }
    }
    if (env.NODE_ENV === 'production' && env.DATABASE_URL === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['DATABASE_URL'],
        message: 'is required when NODE_ENV=production',
      });
    }
  });

export interface EmailConfig {
  /** Which `EmailSender` delivers mail. Only `console` (delivers nothing) exists so far. */
  readonly provider: EmailProvider;
  /** Development aid: print whole messages, links included, to the console. Never in production. */
  readonly devPrintLinks: boolean;
  /** Origin of the web app; emailed links are built from it. */
  readonly webBaseUrl: string;
}

export interface JobsConfig {
  /** Whether this process runs the scheduler (airing sync, inbox fan-out, refresh, cleanup). */
  readonly enabled: boolean;
}

export interface SourcesConfig {
  /** Override of the AniList GraphQL endpoint; undefined = the public one. */
  readonly anilistUrl: string | undefined;
  /** Override of the Jikan base URL (including /v4); undefined = the public one. */
  readonly jikanUrl: string | undefined;
  /** Per-request timeout towards a source (doc 05 §4: 5 s). */
  readonly timeoutMs: number;
}

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
  readonly email: EmailConfig;
  readonly sources: SourcesConfig;
  readonly jobs: JobsConfig;
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
    email: {
      provider: env.EMAIL_PROVIDER,
      devPrintLinks: env.EMAIL_DEV_PRINT_LINKS,
      webBaseUrl: env.WEB_BASE_URL ?? DEV_WEB_BASE_URL,
    },
    sources: {
      anilistUrl: env.SOURCE_ANILIST_URL,
      jikanUrl: env.SOURCE_JIKAN_URL,
      timeoutMs: env.SOURCE_TIMEOUT_MS,
    },
    jobs: { enabled: env.JOBS_ENABLED ?? env.NODE_ENV === 'production' },
    trustProxyHops: env.TRUST_PROXY_HOPS,
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
  };
}
