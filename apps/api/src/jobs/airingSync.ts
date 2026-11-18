import type { DbClient } from '../db/index.js';
import type { Logger } from '../lib/logger.js';
import type { SourceGateway } from '../sources/index.js';
import { SourcesUnavailableError } from '../sources/index.js';

/** How far back the window reaches: an episode that aired while we were down is still found. */
export const AIRING_LOOK_BACK_MS = 24 * 60 * 60 * 1000;
/** How far ahead the schedule is kept (the Home and Inbox screens show "next airing"). */
export const AIRING_LOOK_AHEAD_MS = 7 * 24 * 60 * 60 * 1000;
/** Titles asked about in one request. */
const CHUNK = 50;

export interface AiringSyncResult {
  /** Titles somebody is watching that can still air. */
  readonly titles: number;
  readonly created: number;
  readonly rescheduled: number;
  /** True when AniList could not be asked (the next run tries again). */
  readonly sourcesUnavailable: boolean;
}

interface WatchedTitle {
  readonly title_id: string;
  readonly external_id: string;
}

/**
 * The airing-sync job (doc 05 §7): learn the schedule of every title someone is watching, and
 * keep `airing_episode` in step with it. Only AniList publishes schedules (Jikan has none), so a
 * title without an AniList ID is skipped. Idempotent: running it twice changes nothing, and an
 * episode whose time moved is updated in place (its row, and so its notifications, stay one).
 */
export async function syncAiring(options: {
  readonly db: DbClient;
  readonly gateway: SourceGateway;
  readonly now: Date;
  readonly logger?: Logger;
}): Promise<AiringSyncResult> {
  const { db, gateway, now } = options;
  const watched = await db.$queryRaw<WatchedTitle[]>`
    SELECT DISTINCT t.id::text AS title_id, x.external_id
    FROM title t
    JOIN title_external_id x ON x.title_id = t.id AND x.source = 'anilist'
    JOIN library_entry e ON e.title_id = t.id AND e.status = 'watching' AND e.removed_at IS NULL
    JOIN "user" u ON u.id = e.user_id AND u.deleted_at IS NULL
    WHERE t.status IN ('releasing', 'not_yet_released', 'hiatus')
    ORDER BY x.external_id`;
  const titleByExternal = new Map(watched.map((row) => [row.external_id, row.title_id]));
  const from = new Date(now.getTime() - AIRING_LOOK_BACK_MS);
  const to = new Date(now.getTime() + AIRING_LOOK_AHEAD_MS);

  let created = 0;
  let rescheduled = 0;
  const externalIds = [...titleByExternal.keys()];
  for (let start = 0; start < externalIds.length; start += CHUNK) {
    let episodes;
    try {
      episodes = (await gateway.getAiring(externalIds.slice(start, start + CHUNK), from, to)).data;
    } catch (error) {
      if (!(error instanceof SourcesUnavailableError)) throw error;
      options.logger?.warn(
        { causes: error.causes.map((cause) => cause.kind) },
        'airing sync: the schedule could not be fetched',
      );
      return { titles: watched.length, created, rescheduled, sourcesUnavailable: true };
    }
    for (const episode of episodes) {
      const titleId = titleByExternal.get(episode.externalId);
      if (titleId === undefined) continue;
      const existing = await db.airingEpisode.findUnique({
        where: { titleId_episodeNumber: { titleId, episodeNumber: episode.episode } },
        select: { airsAt: true },
      });
      if (existing === null) {
        await db.airingEpisode.upsert({
          where: { titleId_episodeNumber: { titleId, episodeNumber: episode.episode } },
          create: {
            titleId,
            episodeNumber: episode.episode,
            airsAt: episode.airsAt,
            source: 'anilist',
          },
          update: {},
        });
        created += 1;
      } else if (existing.airsAt.getTime() !== episode.airsAt.getTime()) {
        await db.airingEpisode.update({
          where: { titleId_episodeNumber: { titleId, episodeNumber: episode.episode } },
          data: { airsAt: episode.airsAt },
        });
        rescheduled += 1;
      }
    }
  }
  return { titles: watched.length, created, rescheduled, sourcesUnavailable: false };
}
