import type { DbClient } from '../db/index.js';

/** The merge cannot be done as asked (same title twice, unknown title). Nothing was changed. */
export class MergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MergeError';
  }
}

export interface MergeSummary {
  readonly keepId: string;
  readonly mergedId: string;
  /** Library entries that moved to the kept title. */
  readonly entriesMoved: number;
  /** Users who had BOTH titles: their two entries became one. */
  readonly entriesCombined: number;
  readonly eventsRepointed: number;
  readonly externalIdsMoved: number;
  /** IDs the kept title could not hold (it has another at that source): now overrides to it. */
  readonly externalIdsOverridden: number;
}

interface EntryRow {
  id: string;
  user_id: string;
  status: string;
  progress: number;
  episodes_total_override: number | null;
  rating: number | null;
  review: string | null;
  is_favorite: boolean;
  alerts_enabled: boolean | null;
  notes: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  updated_at: Date;
  removed_at: Date | null;
}

/**
 * Merge a duplicate title into the one to keep (doc 05 §5: "repoints library_entry, event, etc.").
 * Everything happens in ONE transaction: it either completes or changes nothing.
 *
 * Nothing a user did is lost:
 *  - every event moves to the kept title (the append-only trigger is opened for this one purpose
 *    and only lets `title_id`, `entry_id` and `run_id` change);
 *  - a user who had both titles keeps one entry: the more recently updated entry's status and
 *    progress win, fields the survivor lacks (rating, review, notes, favourite) are filled from
 *    the other, and the other entry's viewing runs are renumbered after the survivor's;
 *  - the merged title's external IDs move to the kept title, or become overrides to it, so a
 *    source that still reports the old ID resolves to the kept title.
 */
export async function mergeTitles(
  db: DbClient,
  keepId: string,
  mergedId: string,
): Promise<MergeSummary> {
  if (keepId === mergedId) throw new MergeError('cannot merge a title into itself');

  return db.$transaction(
    async (tx) => {
      // Both titles are locked for the whole merge (in a fixed order, so two merges cannot deadlock).
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id::text FROM title WHERE id IN (${keepId}::uuid, ${mergedId}::uuid) ORDER BY id FOR UPDATE`;
      if (rows.length !== 2) throw new MergeError('both titles must exist');
      await tx.$executeRaw`SELECT set_config('akiba.event_maintenance', 'merge', true)`;

      // ── Library entries ───────────────────────────────────────────────────────────────
      const pairs = await tx.$queryRaw<{ keep_entry: string; merged_entry: string }[]>`
        SELECT k.id::text AS keep_entry, m.id::text AS merged_entry
        FROM library_entry k JOIN library_entry m ON m.user_id = k.user_id
        WHERE k.title_id = ${keepId}::uuid AND m.title_id = ${mergedId}::uuid`;

      for (const pair of pairs) {
        const entries = await tx.$queryRaw<EntryRow[]>`
          SELECT id::text, user_id::text, status::text, progress, episodes_total_override, rating,
                 review, is_favorite, alerts_enabled, notes, started_at, completed_at, updated_at,
                 removed_at
          FROM library_entry WHERE id IN (${pair.keep_entry}::uuid, ${pair.merged_entry}::uuid)`;
        const keep = entries.find((entry) => entry.id === pair.keep_entry);
        const other = entries.find((entry) => entry.id === pair.merged_entry);
        if (keep === undefined || other === undefined) continue;
        const newer = other.updated_at > keep.updated_at ? other : keep;

        // Runs of the other entry follow the survivor's, in order.
        const max = await tx.$queryRaw<{ max: number | null }[]>`
          SELECT max(run_number) AS max FROM viewing_run WHERE entry_id = ${keep.id}::uuid`;
        let next = (max[0]?.max ?? 0) + 1;
        const survivorHasOpenRun =
          (
            await tx.$queryRaw<{ n: number }[]>`
              SELECT count(*)::int AS n FROM viewing_run
              WHERE entry_id = ${keep.id}::uuid AND finished_at IS NULL`
          )[0]?.n === 1;
        const runs = await tx.$queryRaw<{ id: string; finished_at: Date | null }[]>`
          SELECT id::text, finished_at FROM viewing_run
          WHERE entry_id = ${other.id}::uuid ORDER BY run_number`;
        for (const run of runs) {
          // Only one run per entry may be open; a second open run is closed where it stands.
          if (run.finished_at === null && survivorHasOpenRun) {
            // Closed BEFORE it moves: two open runs on one entry would break the unique index.
            await tx.$executeRaw`
              UPDATE viewing_run
              SET finished_at = greatest(started_at, now()), progress_at_end = ${other.progress}
              WHERE id = ${run.id}::uuid`;
          }
          await tx.$executeRaw`
            UPDATE viewing_run SET entry_id = ${keep.id}::uuid, run_number = ${next}
            WHERE id = ${run.id}::uuid`;
          next += 1;
        }

        await tx.$executeRaw`
          UPDATE event SET entry_id = ${keep.id}::uuid, title_id = ${keepId}::uuid
          WHERE entry_id = ${other.id}::uuid`;

        const override = newer.episodes_total_override ?? keep.episodes_total_override;
        const progress = override === null ? newer.progress : Math.min(newer.progress, override);
        await tx.$executeRaw`
          UPDATE library_entry SET
            status = ${newer.status}::entry_status,
            progress = ${progress},
            episodes_total_override = ${override},
            rating = ${keep.rating ?? other.rating},
            review = ${keep.review ?? other.review},
            notes = ${keep.notes ?? other.notes},
            is_favorite = ${keep.is_favorite || other.is_favorite},
            alerts_enabled = ${keep.alerts_enabled ?? other.alerts_enabled},
            started_at = ${earliest(keep.started_at, other.started_at)},
            completed_at = ${newer.completed_at},
            removed_at = ${keep.removed_at !== null && other.removed_at !== null ? newer.removed_at : null},
            updated_at = now()
          WHERE id = ${keep.id}::uuid`;
        await tx.$executeRaw`DELETE FROM library_entry WHERE id = ${other.id}::uuid`;
      }

      const moved = await tx.$executeRaw`
        UPDATE library_entry SET title_id = ${keepId}::uuid WHERE title_id = ${mergedId}::uuid`;
      const eventsRepointed = await tx.$executeRaw`
        UPDATE event SET title_id = ${keepId}::uuid WHERE title_id = ${mergedId}::uuid`;

      // ── Airing and notifications ──────────────────────────────────────────────────────
      // Episodes both titles have: the kept title's row stays and the notifications follow it.
      await tx.$executeRaw`
        DELETE FROM notification n USING airing_episode me, airing_episode ke
        WHERE n.episode_id = me.id AND me.title_id = ${mergedId}::uuid
          AND ke.title_id = ${keepId}::uuid AND ke.episode_number = me.episode_number
          AND EXISTS (SELECT 1 FROM notification k WHERE k.user_id = n.user_id AND k.episode_id = ke.id)`;
      await tx.$executeRaw`
        UPDATE notification n SET episode_id = ke.id
        FROM airing_episode me, airing_episode ke
        WHERE n.episode_id = me.id AND me.title_id = ${mergedId}::uuid
          AND ke.title_id = ${keepId}::uuid AND ke.episode_number = me.episode_number`;
      await tx.$executeRaw`
        DELETE FROM airing_episode me USING airing_episode ke
        WHERE me.title_id = ${mergedId}::uuid AND ke.title_id = ${keepId}::uuid
          AND ke.episode_number = me.episode_number`;
      await tx.$executeRaw`UPDATE airing_episode SET title_id = ${keepId}::uuid WHERE title_id = ${mergedId}::uuid`;
      await tx.$executeRaw`UPDATE notification SET title_id = ${keepId}::uuid WHERE title_id = ${mergedId}::uuid`;

      // ── Catalog links ─────────────────────────────────────────────────────────────────
      await tx.$executeRaw`
        DELETE FROM title_relation
        WHERE (from_title_id = ${mergedId}::uuid AND to_title_id = ${keepId}::uuid)
           OR (from_title_id = ${keepId}::uuid AND to_title_id = ${mergedId}::uuid)`;
      await tx.$executeRaw`
        INSERT INTO title_relation (from_title_id, to_title_id, relation_type)
        SELECT ${keepId}::uuid, to_title_id, relation_type FROM title_relation
        WHERE from_title_id = ${mergedId}::uuid ON CONFLICT DO NOTHING`;
      await tx.$executeRaw`
        INSERT INTO title_relation (from_title_id, to_title_id, relation_type)
        SELECT from_title_id, ${keepId}::uuid, relation_type FROM title_relation
        WHERE to_title_id = ${mergedId}::uuid ON CONFLICT DO NOTHING`;
      await tx.$executeRaw`
        INSERT INTO title_studio (title_id, studio_id, is_main)
        SELECT ${keepId}::uuid, studio_id, is_main FROM title_studio
        WHERE title_id = ${mergedId}::uuid ON CONFLICT DO NOTHING`;
      await tx.$executeRaw`
        INSERT INTO title_genre (title_id, genre_id)
        SELECT ${keepId}::uuid, genre_id FROM title_genre
        WHERE title_id = ${mergedId}::uuid ON CONFLICT DO NOTHING`;
      await tx.$executeRaw`
        INSERT INTO title_character (title_id, character_id, role)
        SELECT ${keepId}::uuid, character_id, role FROM title_character
        WHERE title_id = ${mergedId}::uuid ON CONFLICT DO NOTHING`;
      await tx.$executeRaw`
        UPDATE title SET franchise_id = (SELECT franchise_id FROM title WHERE id = ${mergedId}::uuid)
        WHERE id = ${keepId}::uuid AND franchise_id IS NULL`;

      // ── External IDs and overrides ────────────────────────────────────────────────────
      const kept = await tx.titleExternalId.findMany({ where: { titleId: keepId } });
      const mine = await tx.titleExternalId.findMany({ where: { titleId: mergedId } });
      let externalIdsMoved = 0;
      let externalIdsOverridden = 0;
      for (const row of mine) {
        if (kept.some((other) => other.source === row.source)) {
          // One ID per source per title: the old ID stays resolvable through an override.
          await tx.titleExternalId.delete({ where: { id: row.id } });
          await tx.mappingOverride.upsert({
            where: { source_externalId: { source: row.source, externalId: row.externalId } },
            create: { source: row.source, externalId: row.externalId, titleId: keepId },
            update: { titleId: keepId },
          });
          externalIdsOverridden += 1;
        } else {
          await tx.titleExternalId.update({ where: { id: row.id }, data: { titleId: keepId } });
          kept.push({ ...row, titleId: keepId });
          externalIdsMoved += 1;
        }
      }
      await tx.mappingOverride.updateMany({
        where: { titleId: mergedId },
        data: { titleId: keepId },
      });

      await tx.title.delete({ where: { id: mergedId } });

      return {
        keepId,
        mergedId,
        entriesMoved: Number(moved),
        entriesCombined: pairs.length,
        eventsRepointed: Number(eventsRepointed),
        externalIdsMoved,
        externalIdsOverridden,
      };
    },
    { timeout: 60_000 },
  );
}

function earliest(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}
