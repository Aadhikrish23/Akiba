import { Writable } from 'node:stream';
import type { Express } from 'express';
import { createApp, type AppDependencies } from '../app.js';
import { loadEnv, type AppConfig } from '../config/env.js';
import { createLogger, type Logger } from '../lib/logger.js';

/** Collects pino output in memory so tests can assert on what was (not) logged. */
export class LogSink extends Writable {
  readonly chunks: string[] = [];

  override _write(chunk: Buffer | string, _encoding: string, callback: () => void): void {
    this.chunks.push(chunk.toString());
    callback();
  }

  get text(): string {
    return this.chunks.join('');
  }

  get lines(): Record<string, unknown>[] {
    return this.text
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

export function testConfig(env: Record<string, string> = {}): AppConfig {
  return loadEnv({ NODE_ENV: 'test', ...env });
}

export interface TestApp {
  readonly app: Express;
  readonly logs: LogSink;
  readonly logger: Logger;
}

export function buildTestApp(
  options: { env?: Record<string, string> } & Partial<
    Omit<AppDependencies, 'config' | 'logger'>
  > = {},
): TestApp {
  const { env, ...dependencies } = options;
  const logs = new LogSink();
  const logger = createLogger({ level: 'debug', destination: logs });
  const app = createApp({ config: testConfig(env), logger, ...dependencies });
  return { app, logs, logger };
}
