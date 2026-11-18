import type { TitleCharacter, VoiceActor } from '@akiba/shared';
import type { Prisma, DbClient, DbTransaction } from '../../db/index.js';
import type { SourceCharacter, SourceVoiceActor } from '../../sources/types.js';

/**
 * Characters and voice actors (FR-EXP-004). A character is one row however many titles it appears
 * in, found by its AniList ID; the same holds for a voice actor. Both unique indexes live in the
 * migration, so two refreshes that share a character race safely: one inserts, the other updates.
 */

/** Rows are written in ID order, so two transactions touching the same rows cannot deadlock. */
const byExternalId = <T extends { readonly externalId: string }>(a: T, b: T): number =>
  Number(a.externalId) - Number(b.externalId);

async function upsertCharacters(
  tx: DbTransaction,
  characters: readonly SourceCharacter[],
): Promise<Map<string, string>> {
  const rows = [...characters].sort(byExternalId);
  const result = await tx.$queryRaw<{ id: string; ext: string }[]>`
    INSERT INTO character (name, native_name, image_url, description, external_ids)
    SELECT name, native_name, image_url, description, jsonb_build_object('anilist', ext)
    FROM unnest(
      ${rows.map((row) => row.name)}::text[],
      ${rows.map((row) => row.nativeName)}::text[],
      ${rows.map((row) => row.imageUrl)}::text[],
      ${rows.map((row) => row.description)}::text[],
      ${rows.map((row) => row.externalId)}::text[]
    ) AS incoming(name, native_name, image_url, description, ext)
    ON CONFLICT ((external_ids ->> 'anilist')) WHERE external_ids ? 'anilist'
    DO UPDATE SET name = EXCLUDED.name,
                  native_name = EXCLUDED.native_name,
                  image_url = EXCLUDED.image_url,
                  description = EXCLUDED.description
    RETURNING id::text AS id, external_ids ->> 'anilist' AS ext`;
  return new Map(result.map((row) => [row.ext, row.id]));
}

async function upsertVoiceActors(
  tx: DbTransaction,
  actors: readonly SourceVoiceActor[],
): Promise<Map<string, string>> {
  const unique = new Map<string, SourceVoiceActor>();
  for (const actor of actors) unique.set(actor.externalId, actor);
  const rows = [...unique.values()].sort(byExternalId);
  if (rows.length === 0) return new Map();
  const result = await tx.$queryRaw<{ id: string; ext: string }[]>`
    INSERT INTO voice_actor (name, native_name, image_url, external_ids)
    SELECT name, native_name, image_url, jsonb_build_object('anilist', ext)
    FROM unnest(
      ${rows.map((row) => row.name)}::text[],
      ${rows.map((row) => row.nativeName)}::text[],
      ${rows.map((row) => row.imageUrl)}::text[],
      ${rows.map((row) => row.externalId)}::text[]
    ) AS incoming(name, native_name, image_url, ext)
    ON CONFLICT ((external_ids ->> 'anilist')) WHERE external_ids ? 'anilist'
    DO UPDATE SET name = EXCLUDED.name,
                  native_name = EXCLUDED.native_name,
                  image_url = EXCLUDED.image_url
    RETURNING id::text AS id, external_ids ->> 'anilist' AS ext`;
  return new Map(result.map((row) => [row.ext, row.id]));
}

/**
 * Store a title's cast as AniList reported it. An empty list means "the source sent none", so what
 * we have stays (a refresh through the fallback must not wipe the cast). Only AniList IDs are
 * understood: the caller passes characters from AniList only.
 */
export async function replaceCharacters(
  tx: DbTransaction,
  titleId: string,
  characters: readonly SourceCharacter[],
): Promise<void> {
  if (characters.length === 0) return;
  const characterIds = await upsertCharacters(tx, characters);
  const actorIds = await upsertVoiceActors(
    tx,
    characters.flatMap((character) => character.voiceActors),
  );

  await tx.titleCharacter.deleteMany({ where: { titleId } });
  await tx.titleCharacter.createMany({
    data: characters.flatMap((character) => {
      const characterId = characterIds.get(character.externalId);
      return characterId === undefined ? [] : [{ titleId, characterId, role: character.role }];
    }),
    skipDuplicates: true,
  });

  const known = [...characterIds.values()].sort();
  await tx.characterVoiceActor.deleteMany({ where: { characterId: { in: known } } });
  await tx.characterVoiceActor.createMany({
    data: characters.flatMap((character) =>
      character.voiceActors.flatMap((actor) => {
        const characterId = characterIds.get(character.externalId);
        const voiceActorId = actorIds.get(actor.externalId);
        return characterId === undefined || voiceActorId === undefined
          ? []
          : [{ characterId, voiceActorId, language: actor.language }];
      }),
    ),
    skipDuplicates: true,
  });
}

// ── Reading ───────────────────────────────────────────────────────────────────

const voiceActorSelect = {
  language: true,
  voiceActor: { select: { id: true, name: true, nativeName: true, imageUrl: true } },
} satisfies Prisma.CharacterVoiceActorSelect;

type VoiceActorRow = Prisma.CharacterVoiceActorGetPayload<{ select: typeof voiceActorSelect }>;

export const toVoiceActors = (rows: readonly VoiceActorRow[]): VoiceActor[] =>
  rows
    .map((row) => ({ ...row.voiceActor, language: row.language }))
    .sort((a, b) => a.language.localeCompare(b.language) || a.name.localeCompare(b.name));

const ROLE_ORDER = { main: 0, supporting: 1, background: 2 } as const;

/** The cast of a title: main characters first, then supporting, each with its voice actors. */
export async function loadTitleCharacters(
  db: DbClient,
  titleId: string,
): Promise<TitleCharacter[]> {
  const rows = await db.titleCharacter.findMany({
    where: { titleId },
    select: {
      role: true,
      character: {
        select: {
          id: true,
          name: true,
          nativeName: true,
          imageUrl: true,
          voiceActors: { select: voiceActorSelect },
        },
      },
    },
  });
  return rows
    .map((row) => ({
      id: row.character.id,
      name: row.character.name,
      nativeName: row.character.nativeName,
      imageUrl: row.character.imageUrl,
      role: row.role,
      voiceActors: toVoiceActors(row.character.voiceActors),
    }))
    .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.name.localeCompare(b.name));
}

export { voiceActorSelect };
