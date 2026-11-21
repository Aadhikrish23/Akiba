import type { DbClient } from '../db/index.js';
import type { Logger } from '../lib/logger.js';
import type { TitlesService } from '../modules/titles/index.js';
import type { SourceGateway } from '../sources/index.js';
import { syncAiring } from './airingSync.js';
import { purgeDeletedAccounts, purgeExpiredAuthData } from './cleanup.js';
import { fanOutAiredEpisodes } from './inboxFanout.js';
import { createScheduler, type Job, type Scheduler, type Timers } from './scheduler.js';

export * from './airingSync.js';
export * from './cleanup.js';
export * from './inboxFanout.js';
export * from './scheduler.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Titles re-read per metadata-refresh run. */
export const METADATA_REFRESH_BATCH = 100;

export interface JobsOptions {
  readonly db: DbClient;
  readonly gateway: SourceGateway;
  readonly titles: TitlesService;
  readonly logger: Logger;
  readonly now?: () => Date;
  readonly timers?: Timers;
  readonly random?: () => number;
}

/**
 * The jobs of doc 05 §7 that exist so far:
 *
 *  - `airing-sync` (every 15 min): learn the schedule, then announce what has aired;
 *  - `inbox-fanout` (every 5 min): announce what has aired since (cheap, and safe to repeat);
 *  - `metadata-refresh` (every 6 h): re-read shelved titles whose copy has outlived its time to
 *    live (6 h while airing, 7 days once over), so an airing title is refreshed several times a day
 *    and a finished one about weekly, with a request budget per run;
 *  - `account-cleanup` (daily): expired tokens, and accounts past their deletion grace period.
 *
 * `mapping-refresh` (weekly) is still the `mapping:import` command, run by hand or by the host's
 * own cron: it downloads a dataset and belongs to a deployment decision (doc 10 §M7).
 */
export function createJobs(options: JobsOptions): Job[] {
  const now = options.now ?? (() => new Date());
  const { db } = options;
  return [
    {
      name: 'airing-sync',
      everyMs: 15 * MINUTE,
      firstRunAfterMs: 20_000,
      run: async () => {
        const sync = await syncAiring({
          db,
          gateway: options.gateway,
          now: now(),
          logger: options.logger,
        });
        const fanout = await fanOutAiredEpisodes({ db, now: now() });
        return { ...sync, ...fanout };
      },
    },
    {
      name: 'inbox-fanout',
      everyMs: 5 * MINUTE,
      firstRunAfterMs: 60_000,
      run: async () => ({ ...(await fanOutAiredEpisodes({ db, now: now() })) }),
    },
    {
      name: 'metadata-refresh',
      everyMs: 6 * HOUR,
      firstRunAfterMs: 5 * MINUTE,
      run: async () => ({ ...(await options.titles.refreshStale(METADATA_REFRESH_BATCH)) }),
    },
    {
      name: 'account-cleanup',
      everyMs: 24 * HOUR,
      firstRunAfterMs: 10 * MINUTE,
      run: async () => {
        const tokens = await purgeExpiredAuthData(db, now());
        const accounts = await purgeDeletedAccounts(db, now());
        return { ...tokens, accounts };
      },
    },
  ];
}

export function createJobScheduler(options: JobsOptions): Scheduler {
  return createScheduler({
    db: options.db,
    logger: options.logger,
    jobs: createJobs(options),
    ...(options.timers === undefined ? {} : { timers: options.timers }),
    ...(options.random === undefined ? {} : { random: options.random }),
  });
}
