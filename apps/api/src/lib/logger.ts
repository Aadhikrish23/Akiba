import { pino, type DestinationStream, type Logger } from 'pino';

export type { Logger };

/** Keys whose values must never reach the logs (doc 05 §9, doc 09 §7). */
const SENSITIVE_KEYS = [
  'authorization',
  'cookie',
  'set-cookie',
  'password',
  'newPassword',
  'currentPassword',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'secret',
  'DATABASE_URL',
  'databaseUrl',
] as const;

const quote = (key: string): string => (/^[A-Za-z_$][\w$]*$/.test(key) ? key : `["${key}"]`);

/**
 * pino redaction paths: each sensitive key at the top level and up to three levels deep, which
 * covers shapes like `{ req: { headers: { authorization } } }` and `{ body: { password } }`.
 * Redaction is the safety net; the first line of defence is that request logging never records
 * headers or bodies at all.
 */
export const REDACT_PATHS: readonly string[] = SENSITIVE_KEYS.flatMap((key) => {
  const quoted = quote(key);
  const child = quoted.startsWith('[') ? quoted : `.${quoted}`;
  return [quoted, `*${child}`, `*.*${child}`, `*.*.*${child}`];
});

export interface LoggerOptions {
  readonly level: string;
  /** Where log lines go; defaults to stdout. Tests pass an in-memory stream. */
  readonly destination?: DestinationStream;
}

export function createLogger(options: LoggerOptions): Logger {
  const config = {
    level: options.level,
    base: { service: 'akiba-api' },
    redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' },
  };
  return options.destination ? pino(config, options.destination) : pino(config);
}
