import { z } from 'zod';

/**
 * Contracts of the discovery endpoints (doc 07 §3): cards, details, relations, genres and the
 * cursor-paginated list envelope. Akiba IDs only: an external (AniList/MAL) ID never appears.
 */

export const TITLE_KINDS = ['tv', 'movie', 'ova', 'ona', 'special', 'tv_short', 'music'] as const;
export const titleKindSchema = z.enum(TITLE_KINDS);
export type TitleKind = z.infer<typeof titleKindSchema>;

export const TITLE_STATUSES = [
  'finished',
  'releasing',
  'not_yet_released',
  'cancelled',
  'hiatus',
] as const;
export const titleStatusSchema = z.enum(TITLE_STATUSES);
export type TitleStatus = z.infer<typeof titleStatusSchema>;

export const SEASONS = ['winter', 'spring', 'summer', 'fall'] as const;
export const seasonSchema = z.enum(SEASONS);
export type Season = z.infer<typeof seasonSchema>;

export const ENTRY_STATUSES = ['watching', 'completed', 'planned', 'on_hold', 'dropped'] as const;
export const entryStatusSchema = z.enum(ENTRY_STATUSES);
export type EntryStatus = z.infer<typeof entryStatusSchema>;

export const TITLE_SORTS = ['popularity', 'score', 'start_date'] as const;
export const titleSortSchema = z.enum(TITLE_SORTS);
export type TitleSort = z.infer<typeof titleSortSchema>;

export const RELATION_TYPES = [
  'prequel',
  'sequel',
  'side_story',
  'spin_off',
  'parent_story',
  'alternative',
  'adaptation',
  'summary',
  'other',
] as const;
export const relationTypeSchema = z.enum(RELATION_TYPES);
export type RelationType = z.infer<typeof relationTypeSchema>;

/** Where a catalog answer came from (doc 07 §1). `cache` = served from Akiba's own copy. */
export const catalogMetaSchema = z.object({
  stale: z.boolean(),
  source: z.enum(['anilist', 'jikan', 'cache']),
});
export type CatalogMeta = z.infer<typeof catalogMetaSchema>;

/** Enough for a poster card or a list row. */
export const titleCardSchema = z.object({
  id: z.uuid(),
  kind: titleKindSchema,
  titleRomaji: z.string().nullable(),
  titleEnglish: z.string().nullable(),
  titleNative: z.string().nullable(),
  coverUrl: z.string().nullable(),
  /** `#rrggbb` of the cover art's dominant colour; null when the source has none. */
  coverColor: z.string().nullable().default(null),
  format: z.string().nullable(),
  status: titleStatusSchema,
  episodesTotal: z.number().int().nullable(),
  season: seasonSchema.nullable(),
  seasonYear: z.number().int().nullable(),
  averageScore: z.number().int().nullable(),
  /** The caller's own library status for this title; null when it is not on their shelf. */
  libraryStatus: entryStatusSchema.nullable(),
  /** The caller's entry for this title, so any screen can act on it (progress, status). */
  libraryEntryId: z.uuid().nullable(),
});
export type TitleCard = z.infer<typeof titleCardSchema>;

export const studioRefSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  isMain: z.boolean(),
});

export const titleDetailSchema = titleCardSchema.extend({
  synopsis: z.string().nullable(),
  bannerUrl: z.string().nullable(),
  durationMin: z.number().int().nullable(),
  /** `YYYY-MM-DD`, or null when the source knows only part of the date. */
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  popularity: z.number().int().nullable(),
  synonyms: z.array(z.string()),
  genres: z.array(z.string()),
  studios: z.array(studioRefSchema),
  nextAiring: z.object({ episode: z.number().int(), airsAt: z.iso.datetime() }).nullable(),
  /** The franchise this title belongs to; null when it has no related titles (or too many). */
  franchiseId: z.uuid().nullable(),
});
export type TitleDetail = z.infer<typeof titleDetailSchema>;

export const titleListResponseSchema = z.object({
  data: z.array(titleCardSchema),
  nextCursor: z.string().nullable(),
  meta: catalogMetaSchema,
});
export type TitleListResponse = z.infer<typeof titleListResponseSchema>;

export const titleDetailResponseSchema = z.object({
  data: titleDetailSchema,
  meta: catalogMetaSchema,
});
export type TitleDetailResponse = z.infer<typeof titleDetailResponseSchema>;

export const relatedGroupSchema = z.object({
  relationType: relationTypeSchema,
  titles: z.array(titleCardSchema),
});
export const relationsResponseSchema = z.object({
  data: z.array(relatedGroupSchema),
  meta: catalogMetaSchema,
});
export type RelationsResponse = z.infer<typeof relationsResponseSchema>;

export const genresResponseSchema = z.object({ data: z.array(z.string()) });
export type GenresResponse = z.infer<typeof genresResponseSchema>;

/** `GET /seasons/current` and `/seasons/:year/:season` add which season the list is for. */
export const seasonListResponseSchema = titleListResponseSchema.extend({
  season: seasonSchema,
  seasonYear: z.number().int(),
});
export type SeasonListResponse = z.infer<typeof seasonListResponseSchema>;

// ── Query strings ─────────────────────────────────────────────────────────────

const limit = z.coerce.number().int().min(1).max(100).default(24);

const searchTerm = z.string().trim().min(1).max(100);

/** Filters shared by search, browse and the season chart. */
const filterFields = {
  format: titleKindSchema.optional(),
  status: titleStatusSchema.optional(),
  genre: z.string().trim().min(1).max(50).optional(),
  sort: titleSortSchema.optional(),
};

export const searchQuerySchema = z.strictObject({
  q: searchTerm,
  format: filterFields.format,
  limit,
  cursor: z.string().max(512).optional(),
});

export const browseQuerySchema = z.strictObject({
  ...filterFields,
  season: seasonSchema.optional(),
  year: z.coerce.number().int().min(1940).max(2100).optional(),
  limit,
  cursor: z.string().max(512).optional(),
});

export const seasonQuerySchema = z.strictObject({
  genre: filterFields.genre,
  format: filterFields.format,
  sort: filterFields.sort,
  limit,
  cursor: z.string().max(512).optional(),
});

export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type BrowseQuery = z.infer<typeof browseQuerySchema>;
export type SeasonQuery = z.infer<typeof seasonQuerySchema>;
