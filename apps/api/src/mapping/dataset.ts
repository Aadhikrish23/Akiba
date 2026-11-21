import { z } from 'zod';
import type { DbClient, DbTransaction } from '../db/index.js';
import { attach, lock, owners, recordConflict } from './linking.js';
import { SOURCE_PRIORITY, refKey, type ExternalRef } from './refs.js';

/**
 * The community ID-mapping dataset (Q-02, e.g. Fribb/anime-lists): one record per title listing
 * the IDs it has at each source. The weekly mapping-refresh job calls {@link importDataset}.
 */

export interface DatasetRow {
  readonly anilist: string | null;
  readonly mal: string | null;
  readonly kitsu: string | null;
}

const idValue = z.union([z.number().int().positive(), z.string().regex(/^[0-9]{1,12}$/)]);

const recordSchema = z.looseObject({
  anilist_id: z.unknown().optional(),
  mal_id: z.unknown().optional(),
  kitsu_id: z.unknown().optional(),
});

export interface ParsedDataset {
  readonly rows: readonly DatasetRow[];
  /** Records with fewer than two usable IDs, or an ID that is a list (ambiguous). */
  readonly skipped: number;
}

/** Read the dataset's JSON (an array of records with `anilist_id`, `mal_id`, `kitsu_id`). */
export function parseDataset(json: unknown): ParsedDataset {
  const list = z.array(z.unknown()).parse(json);
  const rows: DatasetRow[] = [];
  let skipped = 0;
  for (const item of list) {
    const record = recordSchema.safeParse(item);
    if (!record.success) {
      skipped += 1;
      continue;
    }
    const pick = (value: unknown): string | null => {
      const parsed = idValue.safeParse(value);
      return parsed.success ? String(parsed.data) : null;
    };
    const row = {
      anilist: pick(record.data.anilist_id),
      mal: pick(record.data.mal_id),
      kitsu: pick(record.data.kitsu_id),
    };
    // A list of IDs ("this MAL entry covers three AniList entries") cannot be put in one row.
    const ambiguous = [record.data.anilist_id, record.data.mal_id, record.data.kitsu_id].some(
      Array.isArray,
    );
    if (ambiguous || [row.anilist, row.mal, row.kitsu].filter((id) => id !== null).length < 2) {
      skipped += 1;
      continue;
    }
    rows.push(row);
  }
  return { rows, skipped };
}

export interface ImportSummary {
  /** New dataset rows stored. */
  readonly added: number;
  /** Rows already stored, unchanged. */
  readonly unchanged: number;
  /** Rows that gained an ID they lacked. */
  readonly enriched: number;
  /** Rows queued in `mapping_conflict` instead of being stored or applied. */
  readonly conflicts: number;
  /** Cross-source IDs added to titles that already existed. */
  readonly linked: number;
}

const COLUMN = { anilist: 'anilistId', mal: 'malId', kitsu: 'kitsuId' } as const;

const refsOfRow = (row: DatasetRow): ExternalRef[] =>
  SOURCE_PRIORITY.flatMap((source) => {
    const externalId = row[source];
    return externalId === null ? [] : [{ source, externalId }];
  });

/** Import one row. Runs in its own transaction so a conflict in one row never blocks the rest. */
async function importRow(
  tx: DbTransaction,
  row: DatasetRow,
  counters: { -readonly [K in keyof ImportSummary]: number },
): Promise<void> {
  const refs = refsOfRow(row);
  await lock(tx, refs);

  // 1. The dataset itself must not contradict itself.
  const existing = await tx.mappingDatasetEntry.findMany({
    where: { OR: refs.map((ref) => ({ [COLUMN[ref.source]]: ref.externalId })) },
  });
  let contradiction: ExternalRef[] | undefined;
  for (const entry of existing) {
    for (const source of SOURCE_PRIORITY) {
      const current =
        source === 'anilist' ? entry.anilistId : source === 'mal' ? entry.malId : entry.kitsuId;
      const incoming = row[source];
      if (current !== null && incoming !== null && current !== incoming) {
        contradiction = [
          { source, externalId: incoming },
          { source, externalId: current },
        ];
      }
    }
  }
  if (existing.length > 1 && contradiction === undefined) {
    // The new row bridges two stored rows: they disagree about which entries are one title.
    const [first, second] = existing;
    if (first !== undefined && second !== undefined) {
      contradiction = [
        { source: 'anilist', externalId: first.anilistId ?? first.malId ?? first.kitsuId ?? '' },
        { source: 'anilist', externalId: second.anilistId ?? second.malId ?? second.kitsuId ?? '' },
      ];
    }
  }
  if (contradiction !== undefined) {
    const [a, b] = contradiction;
    if (a !== undefined && b !== undefined) {
      await recordConflict(tx, a, b, 'the mapping dataset disagrees with itself');
    }
    counters.conflicts += 1;
    return;
  }

  const stored = existing[0];
  if (stored === undefined) {
    await tx.mappingDatasetEntry.create({
      data: { anilistId: row.anilist, malId: row.mal, kitsuId: row.kitsu },
    });
    counters.added += 1;
  } else {
    const gains =
      (stored.anilistId === null && row.anilist !== null) ||
      (stored.malId === null && row.mal !== null) ||
      (stored.kitsuId === null && row.kitsu !== null);
    if (gains) {
      await tx.mappingDatasetEntry.update({
        where: { id: stored.id },
        data: {
          anilistId: stored.anilistId ?? row.anilist,
          malId: stored.malId ?? row.mal,
          kitsuId: stored.kitsuId ?? row.kitsu,
        },
      });
      counters.enriched += 1;
    } else {
      counters.unchanged += 1;
    }
  }

  // 2. Titles that already exist: give them the IDs the dataset knows (manual overrides win).
  const overridden = new Set(
    (
      await tx.mappingOverride.findMany({
        where: { OR: refs.map((ref) => ({ source: ref.source, externalId: ref.externalId })) },
      })
    ).map((override) => refKey({ source: override.source, externalId: override.externalId })),
  );
  const usable = refs.filter((ref) => !overridden.has(refKey(ref)));
  const owned = await owners(tx, usable);
  const titleIds = [...new Set(owned.map((owner) => owner.titleId))];
  if (titleIds.length > 1) {
    const [first, second] = owned;
    if (first !== undefined && second !== undefined && first.titleId !== second.titleId) {
      await recordConflict(
        tx,
        { source: first.source, externalId: first.externalId },
        { source: second.source, externalId: second.externalId },
        'the dataset says these IDs are one title, but Akiba has them as different titles',
      );
    }
    counters.conflicts += 1;
    return;
  }
  const titleId = titleIds[0];
  if (titleId !== undefined) {
    const before = await tx.titleExternalId.count({ where: { titleId } });
    const clashes = await attach(tx, titleId, usable);
    const after = await tx.titleExternalId.count({ where: { titleId } });
    counters.linked += after - before;
    counters.conflicts += clashes;
  }
}

export async function importDataset(
  db: DbClient,
  rows: readonly DatasetRow[],
): Promise<ImportSummary> {
  const counters = { added: 0, unchanged: 0, enriched: 0, conflicts: 0, linked: 0 };
  for (const row of rows) {
    await db.$transaction((tx) => importRow(tx, row, counters), { timeout: 15_000 });
  }
  return counters;
}
