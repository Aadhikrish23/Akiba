import type { DbClient } from '../db/index.js';

/**
 * An episode that aired longer ago than this is marked handled without telling anyone: a title
 * we only just learned about must not flood its watchers with "episode 3 aired" a week late.
 */
export const FANOUT_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
/** Episodes handled per transaction. */
const BATCH = 50;

export interface FanoutResult {
  /** Episodes handled in this run. */
  readonly episodes: number;
  /** Notifications created. */
  readonly notifications: number;
  /** Episodes too old to announce, marked handled without notifying (see {@link FANOUT_MAX_AGE_MS}). */
  readonly expired: number;
}

interface DueEpisode {
  readonly id: string;
  readonly title_id: string;
  readonly airs_at: Date;
}

/**
 * The inbox-fanout job (doc 05 §7, FR-NOTE-001, -002, -004): for every episode that has aired and
 * has not been handled, create one notification for each user watching that title whose alerts are
 * on (the entry's own setting wins over the account's). Safe to run at any time, from any number
 * of processes at once:
 *
 *  - an episode is locked while it is handled (`FOR UPDATE SKIP LOCKED`), so two runs never take
 *    the same one;
 *  - a notification is unique per user and episode (`ON CONFLICT DO NOTHING`), so even a repeat
 *    can add nothing;
 *  - the episode is marked handled in the same transaction as its notifications, so a crash
 *    leaves either both or neither, and the next run completes the work.
 *
 * Notifications are never recreated: deleting one removes it for good, because the episode is
 * already marked handled. Accounts in their deletion grace period are skipped.
 */
export async function fanOutAiredEpisodes(options: {
  readonly db: DbClient;
  readonly now: Date;
  readonly maxAgeMs?: number;
}): Promise<FanoutResult> {
  const { db, now } = options;
  const oldest = new Date(now.getTime() - (options.maxAgeMs ?? FANOUT_MAX_AGE_MS));
  let episodes = 0;
  let notifications = 0;
  let expired = 0;

  for (;;) {
    const handled = await db.$transaction(async (tx) => {
      const due = await tx.$queryRaw<DueEpisode[]>`
        SELECT id::text AS id, title_id::text AS title_id, airs_at
        FROM airing_episode
        WHERE airs_at <= ${now} AND aired_processed_at IS NULL
        ORDER BY airs_at, id
        LIMIT ${BATCH}
        FOR UPDATE SKIP LOCKED`;
      let made = 0;
      let old = 0;
      for (const episode of due) {
        if (episode.airs_at < oldest) {
          old += 1;
        } else {
          const rows = await tx.$queryRaw<{ id: string }[]>`
            INSERT INTO notification (user_id, kind, title_id, episode_id)
            SELECT e.user_id, 'episode_aired'::notification_kind, e.title_id, ${episode.id}::uuid
            FROM library_entry e
            JOIN "user" u ON u.id = e.user_id
            WHERE e.title_id = ${episode.title_id}::uuid
              AND e.status = 'watching'
              AND e.removed_at IS NULL
              AND u.deleted_at IS NULL
              AND COALESCE(e.alerts_enabled, u.alerts_enabled)
            ON CONFLICT (user_id, episode_id) DO NOTHING
            RETURNING id::text AS id`;
          made += rows.length;
        }
        await tx.$executeRaw`UPDATE airing_episode SET aired_processed_at = ${now} WHERE id = ${episode.id}::uuid`;
      }
      return { count: due.length, made, old };
    });
    if (handled.count === 0) break;
    episodes += handled.count;
    notifications += handled.made;
    expired += handled.old;
    if (handled.count < BATCH) break;
  }
  return { episodes, notifications, expired };
}
