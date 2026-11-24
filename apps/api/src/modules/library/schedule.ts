import type { ScheduleQuery, ScheduleSlot } from '@akiba/shared';
import type { DbClient } from '../../db/index.js';
import { cardSelect, toCard } from '../titles/catalog.js';

const DAY_MS = 86_400_000;
/** How far back an airing row still counts as "this show is on a weekly run". */
const RUN_FRESH_DAYS = 14;
/** A weekly run is carried forward at most this many weeks (three years): stops a runaway projection. */
const MAX_PROJECTED = 156;

export interface ScheduleService {
  /**
   * The episodes of the caller's Watching and Planned titles that air in `[from, to)`: the times the
   * source has announced, and for a show that is on a weekly run, the following weeks carried
   * forward (marked `projected`) until its last episode. Scoped to the caller.
   */
  slots(userId: string, query: ScheduleQuery): Promise<ScheduleSlot[]>;
}

export function createScheduleService(options: {
  readonly db: DbClient;
  readonly now?: () => Date;
}): ScheduleService {
  const { db } = options;
  const now = options.now ?? (() => new Date());

  return {
    async slots(userId, query) {
      const from = new Date(query.from);
      const to = new Date(query.to);
      const entries = await db.libraryEntry.findMany({
        where: { userId, removedAt: null, status: { in: ['watching', 'planned'] } },
        select: {
          id: true,
          status: true,
          progress: true,
          episodesTotalOverride: true,
          titleId: true,
          title: { select: cardSelect(userId) },
        },
      });
      if (entries.length === 0) return [];

      const titleIds = entries.map((entry) => entry.titleId);
      // What the source has recorded inside the window, and the newest row per title, which is
      // where a weekly run is carried forward from (wherever the window is, even years ahead).
      const announced = await db.airingEpisode.findMany({
        where: { titleId: { in: titleIds }, airsAt: { gte: from, lt: to } },
        select: { titleId: true, episodeNumber: true, airsAt: true },
        orderBy: { airsAt: 'asc' },
      });
      const newest = await db.airingEpisode.findMany({
        where: { titleId: { in: titleIds } },
        select: { titleId: true, episodeNumber: true, airsAt: true },
        orderBy: { airsAt: 'desc' },
        distinct: ['titleId'],
      });

      const slots: ScheduleSlot[] = [];
      for (const entry of entries) {
        const total = entry.episodesTotalOverride ?? entry.title.episodesTotal;
        const push = (episode: number, airsAt: Date, projected: boolean) => {
          slots.push({
            entryId: entry.id,
            title: toCard(entry.title),
            entryStatus: entry.status,
            episode,
            airsAt: airsAt.toISOString(),
            projected,
            progress: entry.progress,
            watched: entry.progress >= episode,
          });
        };

        for (const row of announced) {
          if (row.titleId === entry.titleId) push(row.episodeNumber, row.airsAt, false);
        }

        const latest = newest.find((row) => row.titleId === entry.titleId);
        const onWeeklyRun =
          latest !== undefined &&
          entry.title.status === 'releasing' &&
          latest.airsAt.getTime() >= now().getTime() - RUN_FRESH_DAYS * DAY_MS;
        if (onWeeklyRun) {
          for (let week = 1; week <= MAX_PROJECTED; week += 1) {
            const airsAt = new Date(latest.airsAt.getTime() + week * 7 * DAY_MS);
            const episode = latest.episodeNumber + week;
            if (airsAt >= to || (total !== null && episode > total)) break;
            if (airsAt >= from) push(episode, airsAt, true);
          }
        }
      }
      return slots.sort(
        (a, b) => a.airsAt.localeCompare(b.airsAt) || a.entryId.localeCompare(b.entryId),
      );
    },
  };
}
