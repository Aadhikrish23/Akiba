import { z } from 'zod';
import {
  catalogMetaSchema,
  relationTypeSchema,
  titleCardSchema,
  titleListResponseSchema,
} from './titles.js';

/** T21: franchises, studios and characters (doc 07 §3, FR-EXP-001…004). */

// ── Franchise ─────────────────────────────────────────────────────────────────

/** One title of a franchise: a card (with the caller's own status) and when it began. */
export const franchiseTitleSchema = titleCardSchema.extend({
  /** `YYYY-MM-DD`, or null when the source knows only part of the date. */
  startDate: z.string().nullable(),
  /** Where the caller stands on it: episodes watched and the count to reach (null: not in the library). */
  entry: z
    .object({ progress: z.number().int().min(0), total: z.number().int().min(1).nullable() })
    .nullable()
    .default(null),
});
export type FranchiseTitle = z.infer<typeof franchiseTitleSchema>;

/** A relation between two titles of the franchise, as the sources reported it. */
export const franchiseRelationSchema = z.object({
  fromTitleId: z.uuid(),
  toTitleId: z.uuid(),
  relationType: relationTypeSchema,
});
export type FranchiseRelation = z.infer<typeof franchiseRelationSchema>;

export const franchiseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** Oldest first (unknown dates last). */
  titles: z.array(franchiseTitleSchema),
  relations: z.array(franchiseRelationSchema),
  /** How the caller stands: titles in the franchise, on their shelf, and finished. */
  totals: z.object({
    titles: z.number().int(),
    inLibrary: z.number().int(),
    completed: z.number().int(),
  }),
});
export type Franchise = z.infer<typeof franchiseSchema>;

export const franchiseResponseSchema = z.object({ data: franchiseSchema, meta: catalogMetaSchema });
export type FranchiseResponse = z.infer<typeof franchiseResponseSchema>;

// ── Studios ───────────────────────────────────────────────────────────────────

export const studioSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  isAnimationStudio: z.boolean(),
  /** Works Akiba knows of (a studio's catalog fills in as titles are opened). */
  titleCount: z.number().int(),
});
export type Studio = z.infer<typeof studioSchema>;

export const studioResponseSchema = z.object({ data: studioSchema, meta: catalogMetaSchema });
export type StudioResponse = z.infer<typeof studioResponseSchema>;

/** `GET /studios/:id/titles` is an ordinary title list. */
export const studioTitlesResponseSchema = titleListResponseSchema;

export const studioTitlesQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(24),
  cursor: z.string().max(512).optional(),
});
export type StudioTitlesQuery = z.infer<typeof studioTitlesQuerySchema>;

// ── Characters ────────────────────────────────────────────────────────────────

export const CHARACTER_ROLES = ['main', 'supporting', 'background'] as const;
export const characterRoleSchema = z.enum(CHARACTER_ROLES);
export type CharacterRole = z.infer<typeof characterRoleSchema>;

export const voiceActorSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  nativeName: z.string().nullable(),
  imageUrl: z.string().nullable(),
  /** e.g. "Japanese". */
  language: z.string(),
});
export type VoiceActor = z.infer<typeof voiceActorSchema>;

/** A character as listed on a title page: its role there and who voices it. */
export const titleCharacterSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  nativeName: z.string().nullable(),
  imageUrl: z.string().nullable(),
  role: characterRoleSchema,
  voiceActors: z.array(voiceActorSchema),
});
export type TitleCharacter = z.infer<typeof titleCharacterSchema>;

export const titleCharactersResponseSchema = z.object({
  data: z.array(titleCharacterSchema),
  meta: catalogMetaSchema,
});
export type TitleCharactersResponse = z.infer<typeof titleCharactersResponseSchema>;

export const characterPageSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  nativeName: z.string().nullable(),
  imageUrl: z.string().nullable(),
  /** Plain text, spoilers removed. */
  description: z.string().nullable(),
  voiceActors: z.array(voiceActorSchema),
  /** Main roles first, then the most popular titles. */
  appearances: z.array(z.object({ role: characterRoleSchema, title: titleCardSchema })),
});
export type CharacterPage = z.infer<typeof characterPageSchema>;

export const characterResponseSchema = z.object({
  data: characterPageSchema,
  meta: catalogMetaSchema,
});
export type CharacterResponse = z.infer<typeof characterResponseSchema>;
