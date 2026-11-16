import type { Logger } from './logger.js';

/**
 * Work that continues after the HTTP response has been sent (sending email, and everything
 * behind forgot-password, whose response must not depend on what the work finds).
 *
 * A failed task is logged and never crashes the process or reaches a client. `idle()` resolves
 * when nothing is running, so shutdown and tests can wait for it.
 *
 * This is an in-process stand-in for a job queue: a task that is running when the process dies
 * is lost. The consequences are a missing email, which the user can ask for again.
 */
export class BackgroundTasks {
  readonly #log: Logger;
  readonly #running = new Set<Promise<void>>();

  constructor(logger: Logger) {
    this.#log = logger.child({ module: 'background' });
  }

  /** Start `task` without waiting for it. `name` identifies it in the log if it fails. */
  run(name: string, task: () => Promise<void>): void {
    const promise = (async () => {
      try {
        await task();
      } catch (error) {
        // Only the error's name, not its message or stack: a provider error could quote the
        // email it was given, and an email can contain a one-time link.
        this.#log.error(
          { event: 'background_task_failed', task: name, errorName: errorName(error) },
          'background task failed',
        );
      }
    })();
    this.#running.add(promise);
    void promise.finally(() => this.#running.delete(promise));
  }

  get pending(): number {
    return this.#running.size;
  }

  /**
   * Resolves once no task is running (including tasks started while waiting). With `timeoutMs`,
   * gives up after that long and resolves `false`, so a provider that never answers cannot hold
   * up shutdown for ever.
   */
  async idle(timeoutMs?: number): Promise<boolean> {
    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    while (this.#running.size > 0) {
      const all = Promise.all(this.#running);
      if (deadline === undefined) {
        await all;
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      let timer: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        all.then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => {
            resolve(true);
          }, remaining);
        }),
      ]);
      clearTimeout(timer);
      if (timedOut) return false;
    }
    return true;
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
