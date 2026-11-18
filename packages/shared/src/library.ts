import { z } from 'zod';
import { entryStatusSchema, titleCardSchema, titleKindSchema } from './titles.js';

/**
 * Contracts of the library endpoints (doc 07 §4). Entries reference titles by Akiba ID only; a
 * response carries the title as a card so a screen needs one request, not N+1.
 */

export const NOTES_MAX_LENGTH = 2_000;

export const viewingRunSchema = z.object({
  id: z.uuid(),
  /** 1, 2, …: the first watch is run 1, each rewatch the next number. */
  runNumber: z.number().int().min(1),
  startedAt: z.iso.datetime(),
  /** Null while the run is the current one. */
  finishedAt: z.iso.datetime().nullable(),
  rating: z.number().int().min(1).max(10).nullable(),
  progressAtEnd: z.number().int().min(0).nullable(),
});
export type ViewingRun = z.infer<typeof viewingRunSchema>;

export const libraryEntrySchema = z.object({
  id: z.uuid(),
  title: titleCardSchema,
  status: entryStatusSchema,
  /** Episodes watched in the current run. */
  progress: z.number().int().min(0),
  /** The user's override if set, else the source's count; null while unknown. */
  effectiveTotal: z.number().int().min(1).nullable(),
  /** True when `effectiveTotal` is the user's own number (doc 08 key flow 4: shown as "Edited"). */
  totalOverridden: z.boolean(),
  rating: z.number().int().min(1).max(10).nullable(),
  isFavorite: z.boolean(),
  /** Null = follow the account's setting. */
  alertsEnabled: z.boolean().nullable(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  addedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type LibraryEntry = z.infer<typeof libraryEntrySchema>;

export const libraryEntryDetailSchema = libraryEntrySchema.extend({
  review: z.string().nullable(),
  notes: z.string().nullable(),
  runs: z.array(viewingRunSchema),
});
export type LibraryEntryDetail = z.infer<typeof libraryEntryDetailSchema>;

export const libraryEntryResponseSchema = z.object({ data: libraryEntryDetailSchema });
export type LibraryEntryResponse = z.infer<typeof libraryEntryResponseSchema>;

export const libraryListResponseSchema = z.object({
  data: z.array(libraryEntrySchema),
  nextCursor: z.string().nullable(),
});
export type LibraryListResponse = z.infer<typeof libraryListResponseSchema>;

export const addToLibraryRequestSchema = z.strictObject({
  titleId: z.uuid(),
  status: entryStatusSchema,
});
export type AddToLibraryRequest = z.infer<typeof addToLibraryRequestSchema>;

/** At least one field; unknown fields are refused (doc 09 §4). */
export const updateEntryRequestSchema = z
  .strictObject({
    status: entryStatusSchema.optional(),
    isFavorite: z.boolean().optional(),
    alertsEnabled: z.boolean().nullable().optional(),
    notes: z.string().max(NOTES_MAX_LENGTH).nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { error: 'must change at least one field' });
export type UpdateEntryRequest = z.infer<typeof updateEntryRequestSchema>;

export const LIBRARY_SORTS = ['updated', 'title', 'rating', 'progress', 'start_date'] as const;
export const librarySortSchema = z.enum(LIBRARY_SORTS);
export type LibrarySort = z.infer<typeof librarySortSchema>;

export const libraryListQuerySchema = z.strictObject({
  status: entryStatusSchema.optional(),
  format: titleKindSchema.optional(),
  genre: z.string().trim().min(1).max(50).optional(),
  /** Only entries rated at least this. */
  minRating: z.coerce.number().int().min(1).max(10).optional(),
  year: z.coerce.number().int().min(1940).max(2100).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  sort: librarySortSchema.default('updated'),
  order: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(24),
  cursor: z.string().max(512).optional(),
});
export type LibraryListQuery = z.infer<typeof libraryListQuerySchema>;

/** 409 body extension: the entry the user already has for that title. */
export const alreadyInLibrarySchema = z.object({ entryId: z.uuid() });
