import type { Server } from 'node:http';
import type { Logger } from './logger.js';

export interface ShutdownOptions {
  readonly server: Server;
  readonly logger: Logger;
  /** How long in-flight requests get to finish before their connections are closed. */
  readonly timeoutMs: number;
  /** Extra cleanup (database pools, schedulers) run after the server stops accepting requests. */
  readonly onClose?: () => Promise<void>;
}

/**
 * Build an idempotent graceful-shutdown function: stop accepting connections, drop idle
 * keep-alive sockets, let in-flight requests finish, and force-close whatever is left after
 * `timeoutMs`. Resolves with the process exit code (0 clean, 1 forced or failed).
 */
export function createShutdown(options: ShutdownOptions): (signal: string) => Promise<number> {
  const { server, logger, timeoutMs } = options;
  let pending: Promise<number> | undefined;

  const run = async (signal: string): Promise<number> => {
    logger.info({ signal, timeoutMs }, 'shutdown started');
    let forced = false;
    const timer = setTimeout(() => {
      forced = true;
      logger.warn('shutdown timeout reached; closing open connections');
      server.closeAllConnections();
    }, timeoutMs);

    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        server.closeIdleConnections();
      });
      await options.onClose?.();
    } catch (error) {
      logger.error({ err: error }, 'shutdown failed');
      return 1;
    } finally {
      clearTimeout(timer);
    }
    logger.info({ forced }, 'shutdown complete');
    return forced ? 1 : 0;
  };

  return (signal) => {
    pending ??= run(signal);
    return pending;
  };
}
