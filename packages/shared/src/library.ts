import { z } from 'zod';
import { entryStatusSchema, titleCardSchema, titleKindSchema } from './titles.js';

/**
 * Contracts of the library endpoints (doc 07 §4). Entries reference titles by Akiba ID only; a
 * response carries the title as a card so a screen needs one request, not N+1.
 */

export const NOTES_MAX_LENGTH = 2_000;
export const REVIEW_MAX_LENGTH = 10_000;

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

/** `GET /library/counts`: entries per status, for the tabs of the library screen. */
export const libraryCountsSchema = z.object({
  data: z.object({
    watching: z.number().int().min(0),
    completed: z.number().int().min(0),
    planned: z.number().int().min(0),
    on_hold: z.number().int().min(0),
    dropped: z.number().int().min(0),
    favorites: z.number().int().min(0),
  }),
});
export type LibraryCounts = z.infer<typeof libraryCountsSchema>['data'];

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
    /** 1–10, or null to clear (FR-REM-001). */
    rating: z.number().int().min(1).max(10).nullable().optional(),
    /** Private text review; null or empty deletes it (FR-REM-002). */
    review: z.string().max(REVIEW_MAX_LENGTH).nullable().optional(),
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

// ── Progress, episode total, rewatch (FR-TRK-001…008, FR-REM-004) ─────────────────────

/** `{ delta: 1 }` (or -1 to undo) or `{ set: 12 }`: exactly one of them. */
export const progressRequestSchema = z.union([
  z.strictObject({
    delta: z
      .number()
      .int()
      .min(-100)
      .max(100)
      .refine((value) => value !== 0, { error: 'must not be 0' }),
  }),
  z.strictObject({ set: z.number().int().min(0).max(100_000) }),
]);
export type ProgressRequest = z.infer<typeof progressRequestSchema>;

export const progressResponseSchema = z.object({
  data: libraryEntryDetailSchema,
  /** True when progress has just reached the known total: the client offers "Mark completed?". */
  suggestComplete: z.boolean(),
});
export type ProgressResponse = z.infer<typeof progressResponseSchema>;

export const episodesTotalRequestSchema = z.strictObject({
  total: z.number().int().min(1).max(100_000),
});
export type EpisodesTotalRequest = z.infer<typeof episodesTotalRequestSchema>;

// ── History (FR-REM-003) ──────────────────────────────────────────────────────────────

export const EVENT_TYPES = [
  'entry_added',
  'status_changed',
  'progress_changed',
  'run_started',
  'run_completed',
  'rated',
  'reviewed',
  'favorited',
  'unfavorited',
  'total_overridden',
  'total_override_cleared',
  'entry_removed',
] as const;
export const eventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof eventTypeSchema>;

export const historyItemSchema = z.object({
  id: z.uuid(),
  type: eventTypeSchema,
  occurredAt: z.iso.datetime(),
  /** What happened, as recorded (doc 06 §3): `{from, to}`, `{run_number}`, … */
  payload: z.record(z.string(), z.unknown()),
  entryId: z.uuid(),
  title: titleCardSchema,
});
export type HistoryItem = z.infer<typeof historyItemSchema>;

export const historyResponseSchema = z.object({
  data: z.array(historyItemSchema),
  nextCursor: z.string().nullable(),
});
export type HistoryResponse = z.infer<typeof historyResponseSchema>;

export const historyQuerySchema = z.strictObject({
  /** One or several event types, comma separated. */
  type: z
    .string()
    .max(200)
    .transform((value) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== ''),
    )
    .pipe(z.array(eventTypeSchema).min(1).max(EVENT_TYPES.length))
    .optional(),
  titleId: z.uuid().optional(),
  /** Inclusive start and exclusive end of the period, as ISO 8601 instants. */
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(512).optional(),
});
export type HistoryQuery = z.infer<typeof historyQuerySchema>;

// ── Schedule: the week of the shows you follow ────────────────────────────────────────

/** The longest window one schedule request may ask for. */
export const SCHEDULE_MAX_DAYS = 14;

export const scheduleQuerySchema = z
  .strictObject({
    /** Start of the window (inclusive), UTC. Clients pass the start of the viewer's week. */
    from: z.iso.datetime(),
    /** End of the window (exclusive), UTC. */
    to: z.iso.datetime(),
  })
  .refine(
    ({ from, to }) => {
      const span = Date.parse(to) - Date.parse(from);
      return span > 0 && span <= SCHEDULE_MAX_DAYS * 86_400_000;
    },
    { error: `the window must be forward and at most ${SCHEDULE_MAX_DAYS} days`, path: ['to'] },
  );
export type ScheduleQuery = z.infer<typeof scheduleQuerySchema>;

export const scheduleSlotSchema = z.object({
  entryId: z.uuid(),
  title: titleCardSchema,
  /** The caller's own status for the entry: Watching or Planned. */
  entryStatus: entryStatusSchema,
  episode: z.number().int().min(1),
  airsAt: z.iso.datetime(),
  /** True when the time is the show's usual weekly slot carried forward; the source has not announced it. */
  projected: z.boolean(),
  /** Episodes watched so far in the entry's current run; `watched` is `progress >= episode`. */
  progress: z.number().int().min(0),
  /** The caller has already watched this episode in the current run. */
  watched: z.boolean(),
});
export type ScheduleSlot = z.infer<typeof scheduleSlotSchema>;

export const scheduleResponseSchema = z.object({ data: z.array(scheduleSlotSchema) });
export type ScheduleResponse = z.infer<typeof scheduleResponseSchema>;
