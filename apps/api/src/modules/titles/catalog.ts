import type { TitleCard, TitleDetail } from '@akiba/shared';
import { Prisma, type DbClient, type DbTransaction } from '../../db/index.js';
import { titleColumns } from '../../mapping/titleData.js';
import type { SourceName, SourceTitle, SourceTitleDetail } from '../../sources/types.js';

/** Fields of a card, plus the caller's own library status (a filtered join: one row at most). */
export const cardSelect = (userId: string) =>
  ({
    id: true,
    kind: true,
    titleRomaji: true,
    titleEnglish: true,
    titleNative: true,
    coverUrl: true,
    format: true,
    status: true,
    episodesTotal: true,
    season: true,
    seasonYear: true,
    averageScore: true,
    libraryEntries: {
      where: { userId, removedAt: null },
      select: { status: true },
      take: 1,
    },
  }) satisfies Prisma.TitleSelect;

type CardRow = Prisma.TitleGetPayload<{ select: ReturnType<typeof cardSelect> }>;

export function toCard(row: CardRow): TitleCard {
  return {
    id: row.id,
    kind: row.kind,
    titleRomaji: row.titleRomaji,
    titleEnglish: row.titleEnglish,
    titleNative: row.titleNative,
    coverUrl: row.coverUrl,
    format: row.format,
    status: row.status,
    episodesTotal: row.episodesTotal,
    season: row.season,
    seasonYear: row.seasonYear,
    averageScore: row.averageScore,
    libraryStatus: row.libraryEntries[0]?.status ?? null,
  };
}

/** Cards for `ids`, in that order. Adult titles are left out (Q-10), and so are unknown IDs. */
export async function loadCards(
  db: DbClient,
  ids: readonly string[],
  userId: string,
  includeAdult = false,
): Promise<TitleCard[]> {
  if (ids.length === 0) return [];
  const rows = await db.title.findMany({
    where: { id: { in: [...ids] }, ...(includeAdult ? {} : { isAdult: false }) },
    select: cardSelect(userId),
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row === undefined ? [] : [toCard(row)];
  });
}

const dateOnly = (value: Date | null): string | null =>
  value === null ? null : value.toISOString().slice(0, 10);

/** The full title row for the detail page; `null` when it does not exist or is hidden (adult). */
export async function loadDetail(
  db: DbClient,
  id: string,
  userId: string,
  now: Date,
  includeAdult = false,
): Promise<{
  detail: TitleDetail;
  stale: boolean;
  fetchedAt: Date | null;
  detailFetchedAt: Date | null;
  status: string;
} | null> {
  const row = await db.title.findFirst({
    where: { id, ...(includeAdult ? {} : { isAdult: false }) },
    select: {
      ...cardSelect(userId),
      synopsis: true,
      bannerUrl: true,
      durationMin: true,
      startDate: true,
      endDate: true,
      popularity: true,
      synonyms: true,
      stale: true,
      fetchedAt: true,
      detailFetchedAt: true,
      genres: { select: { genre: { select: { name: true } } } },
      studios: {
        select: { isMain: true, studio: { select: { id: true, name: true } } },
      },
      airingEpisodes: {
        where: { airsAt: { gt: now } },
        orderBy: { airsAt: 'asc' },
        take: 1,
        select: { episodeNumber: true, airsAt: true },
      },
    },
  });
  if (row === null) return null;
  const next = row.airingEpisodes[0];
  return {
    stale: row.stale,
    fetchedAt: row.fetchedAt,
    detailFetchedAt: row.detailFetchedAt,
    status: row.status,
    detail: {
      ...toCard(row),
      synopsis: row.synopsis,
      bannerUrl: row.bannerUrl,
      durationMin: row.durationMin,
      startDate: dateOnly(row.startDate),
      endDate: dateOnly(row.endDate),
      popularity: row.popularity,
      synonyms: row.synonyms,
      genres: row.genres.map((link) => link.genre.name).sort(),
      studios: row.studios
        .map((link) => ({ id: link.studio.id, name: link.studio.name, isMain: link.isMain }))
        .sort((a, b) => Number(b.isMain) - Number(a.isMain) || a.name.localeCompare(b.name)),
      nextAiring:
        next === undefined
          ? null
          : { episode: next.episodeNumber, airsAt: next.airsAt.toISOString() },
    },
  };
}

/** How an answer from a source is merged into the catalog. */
export type MergeMode =
  /** The primary source: its values replace ours. */
  | 'overwrite'
  /** The fallback source: it only fills what we do not have, and the row is marked stale. */
  | 'fill';

const modeFor = (source: SourceName): MergeMode => (source === 'anilist' ? 'overwrite' : 'fill');

/** Columns the fallback source may fill when we have nothing. */
const FILLABLE = [
  'titleRomaji',
  'titleEnglish',
  'titleNative',
  'synopsis',
  'coverUrl',
  'bannerUrl',
  'format',
  'episodesTotal',
  'durationMin',
  'season',
  'seasonYear',
  'startDate',
  'endDate',
  'averageScore',
  'popularity',
] as const;

/** Update card columns from a source title. Never touches IDs, franchise or library data. */
export async function applyCard(
  tx: DbTransaction,
  titleId: string,
  source: SourceTitle,
  now: Date,
): Promise<void> {
  const mode = modeFor(source.source);
  const incoming = titleColumns(source, now);
  if (mode === 'overwrite') {
    await tx.title.update({ where: { id: titleId }, data: { ...incoming, stale: false } });
  } else {
    const current = await tx.title.findUniqueOrThrow({ where: { id: titleId } });
    // Data from the fallback is real but second-hand: it fills gaps only, and the row says stale
    // until the primary answers again.
    const data: Prisma.TitleUncheckedUpdateInput = { fetchedAt: now, stale: true };
    const writable = data as Record<string, unknown>;
    for (const key of FILLABLE) {
      if (current[key] === null) writable[key] = incoming[key];
    }
    await tx.title.update({ where: { id: titleId }, data });
  }
  await replaceGenres(tx, titleId, source.genres);
}

export async function replaceGenres(
  tx: DbTransaction,
  titleId: string,
  names: readonly string[],
): Promise<void> {
  if (names.length === 0) return;
  await tx.genre.createMany({ data: names.map((name) => ({ name })), skipDuplicates: true });
  const genres = await tx.genre.findMany({ where: { name: { in: [...names] } } });
  await tx.titleGenre.deleteMany({ where: { titleId } });
  await tx.titleGenre.createMany({
    data: genres.map((genre) => ({ titleId, genreId: genre.id })),
    skipDuplicates: true,
  });
}

/**
 * Studios, the next airing and the detail timestamp. Relations are written by the caller (they
 * need the resolver, which opens its own transactions).
 */
export async function applyDetail(
  tx: DbTransaction,
  titleId: string,
  detail: SourceTitleDetail,
  now: Date,
): Promise<void> {
  await applyCard(tx, titleId, detail, now);

  const known = await tx.studio.findMany({ select: { id: true, name: true, externalIds: true } });
  const links: { titleId: string; studioId: string; isMain: boolean }[] = [];
  for (const studio of detail.studios) {
    const key = detail.source === 'anilist' ? 'anilist' : 'mal';
    const found = known.find(
      (candidate) =>
        (candidate.externalIds as Record<string, unknown> | null)?.[key] === studio.externalId,
    );
    let studioId = found?.id;
    if (studioId === undefined) {
      const created = await tx.studio.create({
        data: {
          name: studio.name,
          externalIds: { [key]: studio.externalId },
          isAnimationStudio: studio.isAnimationStudio,
        },
        select: { id: true },
      });
      studioId = created.id;
      known.push({ id: studioId, name: studio.name, externalIds: { [key]: studio.externalId } });
    }
    links.push({ titleId, studioId, isMain: studio.isMain });
  }
  if (detail.studios.length > 0) {
    await tx.titleStudio.deleteMany({ where: { titleId } });
    await tx.titleStudio.createMany({ data: links, skipDuplicates: true });
  }

  if (detail.nextAiring !== null) {
    await tx.airingEpisode.upsert({
      where: {
        titleId_episodeNumber: { titleId, episodeNumber: detail.nextAiring.episode },
      },
      create: {
        titleId,
        episodeNumber: detail.nextAiring.episode,
        airsAt: detail.nextAiring.airsAt,
        source: 'anilist',
      },
      update: { airsAt: detail.nextAiring.airsAt },
    });
  }

  await tx.title.update({
    where: { id: titleId },
    data: { detailFetchedAt: now },
  });
}

export async function replaceRelations(
  tx: DbTransaction,
  fromTitleId: string,
  relations: readonly {
    toTitleId: string;
    relationType: Prisma.TitleRelationCreateManyInput['relationType'];
  }[],
): Promise<void> {
  await tx.titleRelation.deleteMany({ where: { fromTitleId } });
  const rows = relations
    .filter((relation) => relation.toTitleId !== fromTitleId)
    .map((relation) => ({ fromTitleId, ...relation }));
  if (rows.length > 0) await tx.titleRelation.createMany({ data: rows, skipDuplicates: true });
}

// ── Local (cached) search and browse: the answer when no source can be asked ───────────────

export interface LocalFilters {
  /** Adult-rated titles are left out unless the user turned them on (Q-10). */
  readonly includeAdult?: boolean | undefined;
  readonly kind?: string | undefined;
  readonly status?: string | undefined;
  readonly genre?: string | undefined;
  readonly season?: string | undefined;
  readonly seasonYear?: number | undefined;
  readonly sort?: 'popularity' | 'score' | 'start_date' | undefined;
}

/** Cached titles matching a text query (title, English, native, synonyms), best match first. */
export async function localSearchIds(
  db: DbClient,
  query: string,
  filters: LocalFilters,
  offset: number,
  limit: number,
): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT id::text FROM title
    WHERE search @@ websearch_to_tsquery('simple', ${query})
      ${filters.includeAdult === true ? Prisma.empty : Prisma.sql`AND NOT is_adult`}
      ${filters.kind === undefined ? Prisma.empty : Prisma.sql`AND kind = ${filters.kind}::title_kind`}
    ORDER BY ts_rank(search, websearch_to_tsquery('simple', ${query})) DESC,
             popularity ASC NULLS LAST, id
    OFFSET ${offset} LIMIT ${limit}`);
  return rows.map((row) => row.id);
}

export async function localBrowseIds(
  db: DbClient,
  filters: LocalFilters,
  offset: number,
  limit: number,
): Promise<string[]> {
  const where: Prisma.TitleWhereInput = {
    ...(filters.includeAdult === true ? {} : { isAdult: false }),
    ...(filters.kind === undefined ? {} : { kind: filters.kind as never }),
    ...(filters.status === undefined ? {} : { status: filters.status as never }),
    ...(filters.season === undefined ? {} : { season: filters.season as never }),
    ...(filters.seasonYear === undefined ? {} : { seasonYear: filters.seasonYear }),
    ...(filters.genre === undefined
      ? {}
      : { genres: { some: { genre: { name: { equals: filters.genre, mode: 'insensitive' } } } } }),
  };
  const orderBy: Prisma.TitleOrderByWithRelationInput[] =
    filters.sort === 'score'
      ? [{ averageScore: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }]
      : filters.sort === 'start_date'
        ? [{ startDate: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }]
        : [{ popularity: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }];
  const rows = await db.title.findMany({
    where,
    orderBy,
    skip: offset,
    take: limit,
    select: { id: true },
  });
  return rows.map((row) => row.id);
}
