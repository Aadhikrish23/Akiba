import { EXPLICIT_GENRES, type TitleCard, type TitleDetail } from '@akiba/shared';
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
    coverColor: true,
    crunchyrollUrl: true,
    streamingLinks: true,
    format: true,
    status: true,
    episodesTotal: true,
    season: true,
    seasonYear: true,
    averageScore: true,
    // The franchise: its size and the title it is named after (the earliest to start).
    franchise: {
      select: {
        id: true,
        seasonCount: true,
        _count: { select: { titles: true } },
        titles: {
          orderBy: [{ startDate: 'asc' }, { popularity: 'asc' }],
          take: 1,
          select: { titleRomaji: true, titleEnglish: true, titleNative: true },
        },
      },
    },
    libraryEntries: {
      where: { userId, removedAt: null },
      select: { id: true, status: true },
      take: 1,
    },
  }) satisfies Prisma.TitleSelect;

type CardRow = Prisma.TitleGetPayload<{ select: ReturnType<typeof cardSelect> }>;

/** The stored [{site, url}] as the API's list, ignoring anything that is not a link. */
function serviceLinks(value: unknown): { site: string; url: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null) return [];
    const { site, url } = item as { site?: unknown; url?: unknown };
    return typeof site === 'string' && typeof url === 'string' && url.startsWith('https://')
      ? [{ site, url }]
      : [];
  });
}

/** A franchise of one title is no franchise: only two or more are shown as a group. */
function franchiseOf(row: CardRow['franchise']): TitleCard['franchise'] {
  if (row === null || row._count.titles < 2) return null;
  const root = row.titles[0];
  return {
    id: row.id,
    size: row._count.titles,
    seasons: row.seasonCount,
    titleRomaji: root?.titleRomaji ?? null,
    titleEnglish: root?.titleEnglish ?? null,
    titleNative: root?.titleNative ?? null,
  };
}

export function toCard(row: CardRow): TitleCard {
  return {
    id: row.id,
    kind: row.kind,
    titleRomaji: row.titleRomaji,
    titleEnglish: row.titleEnglish,
    titleNative: row.titleNative,
    coverUrl: row.coverUrl,
    coverColor: row.coverColor,
    crunchyrollUrl: row.crunchyrollUrl,
    streamingLinks: serviceLinks(row.streamingLinks),
    format: row.format,
    status: row.status,
    episodesTotal: row.episodesTotal,
    season: row.season,
    seasonYear: row.seasonYear,
    averageScore: row.averageScore,
    franchise: franchiseOf(row.franchise),
    libraryStatus: row.libraryEntries[0]?.status ?? null,
    libraryEntryId: row.libraryEntries[0]?.id ?? null,
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

/** The stored {"130": "https://..."} as the API's map, ignoring anything that is not a link. */
function episodeLinks(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && entry[1].startsWith('https://'),
    ),
  );
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
  /** False for a title stored before episode links were kept: its detail is fetched once more to get them. */
  linksFetched: boolean;
  status: string;
} | null> {
  const row = await db.title.findFirst({
    where: { id, ...(includeAdult ? {} : { isAdult: false }) },
    select: {
      ...cardSelect(userId),
      synopsis: true,
      crunchyrollEpisodes: true,
      bannerUrl: true,
      durationMin: true,
      startDate: true,
      endDate: true,
      popularity: true,
      synonyms: true,
      stale: true,
      franchiseId: true,
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
    linksFetched: row.crunchyrollEpisodes !== null,
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
      franchiseId: row.franchiseId,
      crunchyrollEpisodes: episodeLinks(row.crunchyrollEpisodes),
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
  'coverColor',
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
  if (detail.crunchyrollEpisodes !== undefined && detail.source === 'anilist') {
    await tx.title.update({
      where: { id: titleId },
      data: {
        crunchyrollEpisodes: Object.fromEntries(
          detail.crunchyrollEpisodes.map((item) => [String(item.episode), item.url]),
        ),
      },
    });
  }

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

/** Add relations without touching the ones already stored (a list page knows only some of a title's). */
export async function addRelations(
  tx: DbTransaction,
  relations: readonly {
    fromTitleId: string;
    toTitleId: string;
    relationType: Prisma.TitleRelationCreateManyInput['relationType'];
  }[],
): Promise<void> {
  const rows = relations.filter((relation) => relation.toTitleId !== relation.fromTitleId);
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
      AND NOT EXISTS (
        SELECT 1 FROM title_genre tg JOIN genre g ON g.id = tg.genre_id
          WHERE tg.title_id = title.id AND lower(g.name) = ANY(${EXPLICIT_GENRES.map((name) => name.toLowerCase())}::text[]))
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
    // Explicit titles are never listed, whatever the reader's adult setting.
    NOT: {
      genres: { some: { genre: { name: { in: [...EXPLICIT_GENRES], mode: 'insensitive' } } } },
    },
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
