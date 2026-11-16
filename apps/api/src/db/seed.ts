import type { DbClient, DbTransaction } from './index.js';
import { SEED_GENRES, SEED_RELATIONS, SEED_TITLES, type SeedTitle } from './seedData.js';

export interface SeedOptions {
  /** Also load the development catalog (titles, external IDs, relations, studios). */
  readonly includeDevCatalog: boolean;
}

export interface SeedSummary {
  readonly genres: number;
  /** 0 when the development catalog was not requested. */
  readonly titles: number;
  readonly relations: number;
}

function toDate(value: string | null): Date | null {
  return value === null ? null : new Date(`${value}T00:00:00.000Z`);
}

async function findOrCreateStudio(tx: DbTransaction, name: string): Promise<string> {
  // `studio` has no natural unique key in doc 06, so the seed identifies its own rows by name.
  const existing = await tx.studio.findFirst({ where: { name }, orderBy: { id: 'asc' } });
  if (existing) return existing.id;
  return (await tx.studio.create({ data: { name } })).id;
}

async function upsertTitle(
  tx: DbTransaction,
  seed: SeedTitle,
  genreIds: ReadonlyMap<string, string>,
): Promise<string> {
  const data = {
    kind: seed.kind,
    titleRomaji: seed.titleRomaji,
    titleEnglish: seed.titleEnglish,
    titleNative: seed.titleNative,
    synonyms: [...seed.synonyms],
    synopsis: seed.synopsis,
    status: seed.status,
    episodesTotal: seed.episodesTotal,
    durationMin: seed.durationMin,
    season: seed.season,
    seasonYear: seed.seasonYear,
    startDate: toDate(seed.startDate),
    endDate: toDate(seed.endDate),
    // Sample data, not fetched from a source: mark it so the first refresh replaces it.
    stale: true,
  };

  const identity = seed.externalIds[0];
  const known = await tx.titleExternalId.findUnique({
    where: { source_externalId: { source: identity.source, externalId: identity.externalId } },
  });
  const titleId =
    known === null
      ? (await tx.title.create({ data })).id
      : (await tx.title.update({ where: { id: known.titleId }, data })).id;

  for (const { source, externalId } of seed.externalIds) {
    await tx.titleExternalId.upsert({
      where: { source_externalId: { source, externalId } },
      create: { titleId, source, externalId },
      // An ID that already points at another title is a mapping question, not the seed's call.
      update: {},
    });
  }

  await tx.titleGenre.createMany({
    data: seed.genres.map((name) => {
      const genreId = genreIds.get(name);
      if (genreId === undefined) throw new Error(`seed: unknown genre ${name}`);
      return { titleId, genreId };
    }),
    skipDuplicates: true,
  });

  const studioId = await findOrCreateStudio(tx, seed.studio);
  await tx.titleStudio.createMany({
    data: [{ titleId, studioId, isMain: true }],
    skipDuplicates: true,
  });

  return titleId;
}

/**
 * Load reference data. Idempotent: running it again changes nothing and never duplicates a row.
 * Genres are needed everywhere; the development catalog is opt-in. Runs in one transaction.
 */
export async function seedDatabase(client: DbClient, options: SeedOptions): Promise<SeedSummary> {
  return client.$transaction(async (tx) => {
    await tx.genre.createMany({
      data: SEED_GENRES.map((name) => ({ name })),
      skipDuplicates: true,
    });
    if (!options.includeDevCatalog) {
      return { genres: SEED_GENRES.length, titles: 0, relations: 0 };
    }

    const genres = await tx.genre.findMany({ where: { name: { in: [...SEED_GENRES] } } });
    const genreIds = new Map(genres.map((genre) => [genre.name, genre.id]));

    const titleIds = new Map<string, string>();
    for (const seed of SEED_TITLES) {
      titleIds.set(seed.key, await upsertTitle(tx, seed, genreIds));
    }

    const idOf = (key: string): string => {
      const id = titleIds.get(key);
      if (id === undefined) throw new Error(`seed: relation refers to unknown title ${key}`);
      return id;
    };
    await tx.titleRelation.createMany({
      data: SEED_RELATIONS.map((relation) => ({
        fromTitleId: idOf(relation.from),
        toTitleId: idOf(relation.to),
        relationType: relation.relationType,
      })),
      skipDuplicates: true,
    });

    return {
      genres: SEED_GENRES.length,
      titles: SEED_TITLES.length,
      relations: SEED_RELATIONS.length,
    };
  });
}
