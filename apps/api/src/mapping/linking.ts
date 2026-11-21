import type { DbTransaction } from '../db/index.js';
import { refKey, type ExternalRef } from './refs.js';

/** Shared by the resolver, the dataset importer and manual overrides. All run inside a transaction. */

export async function lock(tx: DbTransaction, refs: readonly ExternalRef[]): Promise<void> {
  // Sorted, so two resolutions that share IDs take their locks in the same order.
  const keys = [...new Set(refs.map(refKey))].sort();
  for (const key of keys) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`akiba:id:${key}`}, 0))`;
  }
}

export async function recordConflict(
  tx: DbTransaction,
  a: ExternalRef,
  b: ExternalRef,
  reason: string,
): Promise<void> {
  const open = await tx.mappingConflict.findMany({
    where: {
      resolvedAt: null,
      reason,
      OR: [
        { sourceA: a.source, idA: a.externalId, sourceB: b.source, idB: b.externalId },
        { sourceA: b.source, idA: b.externalId, sourceB: a.source, idB: a.externalId },
      ],
    },
    select: { id: true },
  });
  if (open.length > 0) return;
  await tx.mappingConflict.create({
    data: { sourceA: a.source, idA: a.externalId, sourceB: b.source, idB: b.externalId, reason },
  });
}

/** IDs registered to each title among `refs`. */
export async function owners(tx: DbTransaction, refs: readonly ExternalRef[]) {
  if (refs.length === 0) return [];
  return tx.titleExternalId.findMany({
    where: { OR: refs.map((ref) => ({ source: ref.source, externalId: ref.externalId })) },
  });
}

/**
 * Can `titleId` take the IDs in `refs`? Not if it already has a DIFFERENT ID at the same
 * source (that would make one title two AniList entries, say).
 */
export async function accepts(
  tx: DbTransaction,
  titleId: string,
  refs: readonly ExternalRef[],
): Promise<ExternalRef | null> {
  const registered = await tx.titleExternalId.findMany({ where: { titleId } });
  for (const ref of refs) {
    const clash = registered.find(
      (row) => row.source === ref.source && row.externalId !== ref.externalId,
    );
    if (clash !== undefined) return { source: clash.source, externalId: clash.externalId };
  }
  return null;
}

/** Register the IDs that nobody owns yet; record a conflict for each one somebody else owns. */
export async function attach(
  tx: DbTransaction,
  titleId: string,
  refs: readonly ExternalRef[],
): Promise<number> {
  let conflicts = 0;
  const known = await owners(tx, refs);
  const registered = await tx.titleExternalId.findMany({ where: { titleId } });
  // An ID pinned to this title by an override (or left behind by a merge) is settled: no conflict.
  const pinned = new Set(
    (
      await tx.mappingOverride.findMany({
        where: {
          titleId,
          OR: refs.map((ref) => ({ source: ref.source, externalId: ref.externalId })),
        },
      })
    ).map((override) => refKey({ source: override.source, externalId: override.externalId })),
  );
  for (const ref of refs) {
    if (pinned.has(refKey(ref))) continue;
    const owner = known.find(
      (row) => row.source === ref.source && row.externalId === ref.externalId,
    );
    if (owner !== undefined) {
      if (owner.titleId !== titleId) {
        // Already queued (the same disagreement seen from the other side)? Nothing new to say.
        const queued = await tx.mappingConflict.count({
          where: {
            resolvedAt: null,
            OR: [
              { sourceA: ref.source, idA: ref.externalId },
              { sourceB: ref.source, idB: ref.externalId },
            ],
          },
        });
        if (queued > 0) {
          conflicts += 1;
          continue;
        }
        const mine = registered.find((row) => row.source === ref.source) ?? registered[0];
        await recordConflict(
          tx,
          ref,
          mine === undefined ? ref : { source: mine.source, externalId: mine.externalId },
          'an external ID is registered to a different title than the one it was just resolved with',
        );
        conflicts += 1;
      }
      continue;
    }
    const sameSource = registered.find((row) => row.source === ref.source);
    if (sameSource !== undefined) {
      await recordConflict(
        tx,
        ref,
        { source: sameSource.source, externalId: sameSource.externalId },
        'the title already has a different ID at this source',
      );
      conflicts += 1;
      continue;
    }
    await tx.titleExternalId.create({
      data: { titleId, source: ref.source, externalId: ref.externalId },
    });
    registered.push({ id: '', titleId, source: ref.source, externalId: ref.externalId });
  }
  return conflicts;
}
