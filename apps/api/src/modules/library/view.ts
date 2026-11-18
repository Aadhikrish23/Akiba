import type { LibraryEntry, LibraryEntryDetail, ViewingRun } from '@akiba/shared';
import type { Prisma } from '../../db/index.js';
import { cardSelect, toCard } from '../titles/catalog.js';

/** Columns of an entry plus its title as a card, for a given reader. */
export const entrySelect = (userId: string) =>
  ({
    id: true,
    status: true,
    progress: true,
    episodesTotalOverride: true,
    rating: true,
    isFavorite: true,
    alertsEnabled: true,
    startedAt: true,
    completedAt: true,
    addedAt: true,
    updatedAt: true,
    title: { select: cardSelect(userId) },
  }) satisfies Prisma.LibraryEntrySelect;

export type EntryRow = Prisma.LibraryEntryGetPayload<{ select: ReturnType<typeof entrySelect> }>;

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/** The override if the user set one, else what the source says (null while unknown). */
export const effectiveTotal = (override: number | null, source: number | null): number | null =>
  override ?? source;

export function toEntry(row: EntryRow): LibraryEntry {
  return {
    id: row.id,
    title: toCard(row.title),
    status: row.status,
    progress: row.progress,
    effectiveTotal: effectiveTotal(row.episodesTotalOverride, row.title.episodesTotal),
    totalOverridden: row.episodesTotalOverride !== null,
    rating: row.rating,
    isFavorite: row.isFavorite,
    alertsEnabled: row.alertsEnabled,
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
    addedAt: row.addedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type RunRow = {
  id: string;
  runNumber: number;
  startedAt: Date;
  finishedAt: Date | null;
  rating: number | null;
  progressAtEnd: number | null;
};

export const toRun = (row: RunRow): ViewingRun => ({
  id: row.id,
  runNumber: row.runNumber,
  startedAt: row.startedAt.toISOString(),
  finishedAt: iso(row.finishedAt),
  rating: row.rating,
  progressAtEnd: row.progressAtEnd,
});

export function toDetail(
  row: EntryRow & { review: string | null; notes: string | null },
  runs: readonly RunRow[],
): LibraryEntryDetail {
  return {
    ...toEntry(row),
    review: row.review,
    notes: row.notes,
    runs: [...runs].sort((a, b) => a.runNumber - b.runNumber).map(toRun),
  };
}
