import type { Prisma } from '../db/index.js';
import type { SourceDate, SourceTitle } from '../sources/types.js';

/** A calendar date only when the source knows all of it; the `date` columns cannot hold less. */
export function fullDate(date: SourceDate | null): Date | null {
  if (date === null || date.month === null || date.day === null) return null;
  const value = new Date(Date.UTC(date.year, date.month - 1, date.day));
  // `Date` rolls 31 February over to March; refuse rather than store a different day.
  return value.getUTCFullYear() === date.year &&
    value.getUTCMonth() === date.month - 1 &&
    value.getUTCDate() === date.day
    ? value
    : null;
}

/**
 * The catalog columns of a title, from what a source reported. Shared by the resolver (first
 * sight of a title) and the catalog cache (refresh). Genres, studios and relations are separate
 * tables and are written by the cache, not here.
 */
export function titleColumns(title: SourceTitle, now: Date): Prisma.TitleUncheckedCreateInput {
  return {
    kind: title.kind,
    titleRomaji: title.titleRomaji,
    titleEnglish: title.titleEnglish,
    titleNative: title.titleNative,
    synonyms: [...title.synonyms],
    synopsis: title.synopsis,
    coverUrl: title.coverUrl,
    coverColor: title.coverColor,
    bannerUrl: title.bannerUrl,
    format: title.format,
    status: title.status,
    episodesTotal:
      title.episodesTotal !== null && title.episodesTotal >= 1 ? title.episodesTotal : null,
    durationMin: title.durationMin,
    season: title.season,
    seasonYear: title.seasonYear,
    startDate: fullDate(title.startDate),
    endDate: fullDate(title.endDate),
    averageScore: title.averageScore,
    popularity: title.popularity,
    isAdult: title.isAdult,
    sourceUpdatedAt: title.sourceUpdatedAt,
    fetchedAt: now,
    stale: false,
  };
}
