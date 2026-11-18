import { z } from 'zod';
import { authUserSchema } from './auth.js';
import { entryStatusSchema, titleCardSchema } from './titles.js';

/** Contracts of the account endpoints (doc 07 §6): profile, share link, public shared view, export. */

export const TITLE_LANGUAGES = ['romaji', 'english', 'native'] as const;
export const titleLanguageSchema = z.enum(TITLE_LANGUAGES);
export type TitleLanguage = z.infer<typeof titleLanguageSchema>;

export const LIBRARY_VIEWS = ['grid', 'list'] as const;
export const libraryViewSchema = z.enum(LIBRARY_VIEWS);
export type LibraryView = z.infer<typeof libraryViewSchema>;

/** An IANA time zone name such as `Asia/Kolkata` (the runtime's own list decides what is valid). */
export const timeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (value) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: value });
        return true;
      } catch {
        return false;
      }
    },
    { error: 'must be a time zone such as Europe/London' },
  );

/** `GET /me`: identity plus the settings of FR-ACCT-001 and FR-LIB-004. */
export const profileSchema = authUserSchema.extend({
  titleLanguage: titleLanguageSchema,
  timeZone: z.string(),
  libraryView: libraryViewSchema,
  /** Default for "episode aired" alerts; each entry may override it. */
  alertsEnabled: z.boolean(),
  /** Adult-rated titles in discovery (Q-10). */
  showAdult: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type Profile = z.infer<typeof profileSchema>;

export const updateProfileRequestSchema = z
  .strictObject({
    displayName: z.string().trim().min(1).max(50).optional(),
    titleLanguage: titleLanguageSchema.optional(),
    timeZone: timeZoneSchema.optional(),
    libraryView: libraryViewSchema.optional(),
    alertsEnabled: z.boolean().optional(),
    showAdult: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { error: 'must change at least one field' });
export type UpdateProfileRequest = z.infer<typeof updateProfileRequestSchema>;

/** `GET /me`. */
export const meResponseSchema = profileSchema;
export type MeResponse = Profile;

/** Deleting an account asks for the password again: a stolen session must not be enough. */
export const deleteAccountRequestSchema = z.strictObject({
  password: z.string().min(1).max(1024),
});
export type DeleteAccountRequest = z.infer<typeof deleteAccountRequestSchema>;

export const deleteAccountResponseSchema = z.object({
  status: z.literal('deletion_scheduled'),
  /** After this instant the account and everything in it is erased. */
  purgeAfter: z.iso.datetime(),
});
export type DeleteAccountResponse = z.infer<typeof deleteAccountResponseSchema>;

export const restoreAccountResponseSchema = z.object({ status: z.literal('restored') });
export type RestoreAccountResponse = z.infer<typeof restoreAccountResponseSchema>;

// ── Share link (FR-SHARE-001…003) ─────────────────────────────────────────────────────

export const shareScopeSchema = z.strictObject({
  /** Which entries are visible, by status. At least one. */
  statuses: z.array(entryStatusSchema).min(1).max(5),
  showRatings: z.boolean(),
  showReviews: z.boolean(),
});
export type ShareScope = z.infer<typeof shareScopeSchema>;

export const putShareRequestSchema = z.strictObject({ scope: shareScopeSchema });
export type PutShareRequest = z.infer<typeof putShareRequestSchema>;

/** `GET /me/share`: whether a link exists. The link itself is never shown again after creation. */
export const shareStatusSchema = z.object({
  active: z.boolean(),
  scope: shareScopeSchema.nullable(),
  createdAt: z.iso.datetime().nullable(),
});
export type ShareStatus = z.infer<typeof shareStatusSchema>;

/** `PUT /me/share`: the only response that carries the token. */
export const shareCreatedSchema = z.object({
  token: z.string(),
  url: z.string(),
  scope: shareScopeSchema,
  createdAt: z.iso.datetime(),
});
export type ShareCreated = z.infer<typeof shareCreatedSchema>;

/** One entry of the public shared list. No IDs of the owner, no events, only what the scope allows. */
export const sharedEntrySchema = z.object({
  title: titleCardSchema,
  status: entryStatusSchema,
  progress: z.number().int().min(0),
  effectiveTotal: z.number().int().nullable(),
  isFavorite: z.boolean(),
  /** Only when the owner chose to show ratings. */
  rating: z.number().int().min(1).max(10).nullable().optional(),
  /** Only when the owner chose to show reviews. */
  review: z.string().nullable().optional(),
  updatedAt: z.iso.datetime(),
});
export type SharedEntry = z.infer<typeof sharedEntrySchema>;

export const sharedListResponseSchema = z.object({
  owner: z.object({ displayName: z.string().nullable() }),
  scope: shareScopeSchema,
  data: z.array(sharedEntrySchema),
  nextCursor: z.string().nullable(),
});
export type SharedListResponse = z.infer<typeof sharedListResponseSchema>;

export const sharedListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(48),
  cursor: z.string().max(512).optional(),
});

/** Version of the export file format; bumped when a field changes meaning. */
export const EXPORT_VERSION = 1;
