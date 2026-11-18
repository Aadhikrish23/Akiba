import type { DbClient } from '../db/index.js';
import type { Logger } from '../lib/logger.js';

/**
 * The in-process scheduler (doc 05 §7): each job runs on its own interval, and a Postgres
 * advisory lock makes sure only one process runs a given job at a time, however many API
 * processes are up. It is designed to move into a worker process later: nothing here knows about
 * HTTP.
 */

export interface Job {
  readonly name: string;
  readonly everyMs: number;
  /** Delay before the first run after start-up (so a restart does not stampede the sources). */
  readonly firstRunAfterMs?: number;
  /** What the job did, for the log. Must be safe to run twice. */
  readonly run: () => Promise<Record<string, unknown>>;
}

export type RunOutcome =
  | { readonly status: 'ran'; readonly result: Record<string, unknown>; readonly ms: number }
  /** Another process (or an earlier run of this one) holds the job. */
  | { readonly status: 'locked' }
  | { readonly status: 'failed'; readonly error: unknown; readonly ms: number };

/** Timer functions, replaceable so a test can fire a job by hand. */
export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: Timers = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref(); // a pending job never keeps the process alive
    return handle;
  },
  clearTimeout: (handle) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

/** Longest a job may hold its lock (the transaction that carries it is cut off after this). */
const LOCK_TIMEOUT_MS = 30 * 60 * 1000;

export interface Scheduler {
  start(): void;
  /** Stop scheduling and wait for the runs in progress to finish (bounded by `timeoutMs`). */
  stop(timeoutMs?: number): Promise<void>;
  /** Run one job now, under its lock. Never rejects. */
  runNow(name: string): Promise<RunOutcome>;
  readonly jobs: readonly string[];
}

/**
 * Take the job's advisory lock for as long as `work` runs. The lock belongs to a transaction held
 * open on one connection for the duration (a transaction-level lock cannot be left behind by a
 * crash: the server drops it with the connection).
 */
async function withJobLock<T>(
  db: DbClient,
  name: string,
  work: () => Promise<T>,
): Promise<{ locked: false } | { locked: true; value: T }> {
  return db.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<{ got: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${`akiba:job:${name}`}, 0)) AS got`;
      if (rows[0]?.got !== true) return { locked: false } as const;
      return { locked: true, value: await work() } as const;
    },
    { timeout: LOCK_TIMEOUT_MS, maxWait: 5_000 },
  );
}

export function createScheduler(options: {
  readonly db: DbClient;
  readonly logger: Logger;
  readonly jobs: readonly Job[];
  readonly timers?: Timers;
  /** Random spread added to each delay (0–1 of the interval's tenth), so processes do not line up. */
  readonly random?: () => number;
}): Scheduler {
  const { db, logger } = options;
  const timers = options.timers ?? realTimers;
  const random = options.random ?? Math.random;
  const byName = new Map(options.jobs.map((job) => [job.name, job]));
  const running = new Map<string, Promise<RunOutcome>>();
  const handles = new Map<string, unknown>();
  let started = false;
  let stopped = false;

  async function execute(job: Job): Promise<RunOutcome> {
    const begin = Date.now();
    try {
      const outcome = await withJobLock(db, job.name, job.run);
      if (!outcome.locked) {
        logger.debug({ job: job.name }, 'job skipped: another process holds it');
        return { status: 'locked' };
      }
      const ms = Date.now() - begin;
      logger.info({ job: job.name, ms, ...outcome.value }, 'job finished');
      return { status: 'ran', result: outcome.value, ms };
    } catch (error) {
      logger.error({ job: job.name, err: error }, 'job failed');
      return { status: 'failed', error, ms: Date.now() - begin };
    }
  }

  function runNow(name: string): Promise<RunOutcome> {
    const job = byName.get(name);
    if (job === undefined) return Promise.reject(new Error(`unknown job: ${name}`));
    // A run still going in this process is not started again on top of itself.
    const current = running.get(name);
    if (current !== undefined) return Promise.resolve({ status: 'locked' });
    const work = execute(job).finally(() => {
      running.delete(name);
    });
    running.set(name, work);
    return work;
  }

  function schedule(job: Job, delay: number): void {
    if (stopped) return;
    handles.set(
      job.name,
      timers.setTimeout(() => {
        void runNow(job.name).then(() => {
          schedule(job, job.everyMs + Math.floor(random() * (job.everyMs / 10)));
        });
      }, delay),
    );
  }

  return {
    jobs: options.jobs.map((job) => job.name),
    runNow,
    start() {
      if (started) return;
      started = true;
      for (const job of options.jobs) {
        schedule(job, (job.firstRunAfterMs ?? 30_000) + Math.floor(random() * 5_000));
      }
      logger.info({ jobs: options.jobs.map((job) => job.name) }, 'scheduler started');
    },
    async stop(timeoutMs = 10_000) {
      stopped = true;
      for (const handle of handles.values()) timers.clearTimeout(handle);
      handles.clear();
      const pending = [...running.values()];
      if (pending.length === 0) return;
      let timer: unknown;
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<void>((resolve) => {
          timer = timers.setTimeout(resolve, timeoutMs);
        }),
      ]);
      timers.clearTimeout(timer);
    },
  };
}
