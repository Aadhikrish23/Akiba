import { z } from 'zod';
import { RATE_LIMIT_DEFAULTS } from './constants.js';

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
    TRUST_PROXY_HOPS: integer({ min: 0, max: 10, fallback: 0 }),
    SHUTDOWN_TIMEOUT_MS: integer({ min: 0, max: 120_000, fallback: 10_000 }),
  })
  .superRefine((env, context) => {
    if (env.NODE_ENV === 'production' && env.DATABASE_URL === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['DATABASE_URL'],
        message: 'is required when NODE_ENV=production',
      });
    }
  });

export type NodeEnv = 'development' | 'test' | 'production';

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
  };
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
    },
    trustProxyHops: env.TRUST_PROXY_HOPS,
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
  };
}
