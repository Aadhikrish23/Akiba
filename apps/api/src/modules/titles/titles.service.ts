import {
  RELATION_TYPES,
  type BrowseQuery,
  type CatalogMeta,
  type RelationsResponse,
  type TitleCharactersResponse,
  type SearchQuery,
  type Season,
  type SeasonListResponse,
  type SeasonQuery,
  type TitleDetailResponse,
  type TitleListResponse,
} from '@akiba/shared';
import type { DbClient } from '../../db/index.js';
import { notFound, sourcesUnavailable } from '../../lib/errors.js';
import { loadTitleCharacters, replaceCharacters } from '../explore/characters.js';
import { recomputeFranchises } from '../explore/franchise.js';
import type { Logger } from '../../lib/logger.js';
import { UnresolvableTitleError, type TitleResolver } from '../../mapping/index.js';
import { SourcesUnavailableError, type SourceGateway, type Sourced } from '../../sources/index.js';
import type {
  ExternalIds,
  PageRequest,
  SourceName,
  SourcePage,
  SourceTitle,
  TitleFilters,
} from '../../sources/types.js';
import {
  addRelations,
  applyCard,
  applyDetail,
  cardSelect,
  loadCards,
  loadDetail,
  localBrowseIds,
  localSearchIds,
  replaceGenres,
  replaceRelations,
  toCard,
  type LocalFilters,
} from './catalog.js';
import { decodeCursor, encodeCursor, type Cursor } from './cursor.js';
import { seasonOf } from '@akiba/shared';

const HOUR = 60 * 60 * 1000;
/** A card seen in a list is refreshed when our copy is older than this. */
export const CARD_TTL_MS = 6 * HOUR;
/** Detail (studios, relations, airing) of a title that is still airing or announced. */
export const LIVE_DETAIL_TTL_MS = 6 * HOUR;
/** Detail of a title that is over: it hardly ever changes. */
export const DONE_DETAIL_TTL_MS = 7 * 24 * HOUR;
/** How long an identical search/browse answer is reused without asking the source again. */
export const LIST_CACHE_TTL_MS = 5 * 60 * 1000;
const LIST_CACHE_MAX = 500;
/** Titles resolved to Akiba IDs in parallel (each takes one database connection). */
const RESOLVE_CONCURRENCY = 4;

export interface TitlesService {
  search(userId: string, query: SearchQuery): Promise<TitleListResponse>;
  browse(userId: string, query: BrowseQuery): Promise<TitleListResponse>;
  season(
    userId: string,
    year: number,
    season: Season,
    query: SeasonQuery,
  ): Promise<SeasonListResponse>;
  currentSeason(userId: string, query: SeasonQuery): Promise<SeasonListResponse>;
  detail(userId: string, titleId: string): Promise<TitleDetailResponse>;
  relations(userId: string, titleId: string): Promise<RelationsResponse>;
  characters(userId: string, titleId: string): Promise<TitleCharactersResponse>;
  /**
   * The metadata-refresh job: re-read the detail of titles that are on someone's shelf and whose
   * copy has outlived its time to live, oldest first, at most `limit`. Stops at the first moment
   * no source can answer.
   */
  refreshStale(limit: number): Promise<RefreshSummary>;
  genres(): Promise<string[]>;
}

export interface RefreshSummary {
  readonly candidates: number;
  readonly refreshed: number;
  readonly failed: number;
  /** True when the sources went away part-way (the rest waits for the next run). */
  readonly stopped: boolean;
}

export interface TitlesServiceOptions {
  readonly db: DbClient;
  readonly gateway: SourceGateway;
  readonly resolver: TitleResolver;
  readonly logger: Logger;
  readonly now?: () => Date;
}

interface CachedPage {
  readonly ids: readonly string[];
  readonly hasNextPage: boolean;
  readonly source: SourceName;
  readonly storedAt: number;
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index] as T);
    }
  });
  await Promise.all(lanes);
  return results;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toSourceFilters(
  adult: boolean,
  filters: {
    format?: string | undefined;
    status?: string | undefined;
    genre?: string | undefined;
    sort?: 'popularity' | 'score' | 'start_date' | undefined;
    season?: Season | undefined;
    year?: number | undefined;
  },
): TitleFilters {
  return {
    ...(filters.format === undefined ? {} : { kind: filters.format as never }),
    ...(filters.status === undefined ? {} : { status: filters.status as never }),
    ...(filters.genre === undefined ? {} : { genre: filters.genre }),
    ...(filters.season === undefined ? {} : { season: filters.season }),
    ...(filters.year === undefined ? {} : { seasonYear: filters.year }),
    ...(filters.sort === undefined
      ? {}
      : { sort: filters.sort === 'start_date' ? ('newest' as const) : filters.sort }),
    // Adult titles are hidden unless the user turned them on in Settings (Q-10).
    includeAdult: adult,
  };
}

export function createTitlesService(options: TitlesServiceOptions): TitlesService {
  const { db, gateway, resolver, logger } = options;
  const now = options.now ?? (() => new Date());
  const listCache = new Map<string, CachedPage>();
  const detailRefreshes = new Map<string, Promise<SourceName | null>>();
  let genreRefresh: Promise<void> | undefined;

  /** Whether this user turned adult-rated titles on (Settings, Q-10). One small read per request. */
  async function adultFor(userId: string): Promise<boolean> {
    const user = await db.user.findUnique({ where: { id: userId }, select: { showAdult: true } });
    return user?.showAdult === true;
  }

  // ── Lists ───────────────────────────────────────────────────────────────────────

  /** Resolve what a source returned to Akiba IDs (FR-DISC-008), refreshing stale cards. */
  async function ingest(items: readonly SourceTitle[], adult: boolean): Promise<string[]> {
    const visible = adult ? items : items.filter((item) => !item.isAdult);
    const resolved = await mapLimit(visible, RESOLVE_CONCURRENCY, async (item) => {
      try {
        const result = await resolver.resolve({ externalIds: item.externalIds, title: item });
        return { item, ...result };
      } catch (error) {
        if (error instanceof UnresolvableTitleError) return null;
        throw error;
      }
    });
    const usable = resolved.flatMap((entry) => (entry === null ? [] : [entry]));

    const existing = usable.filter((entry) => !entry.created);
    if (existing.length > 0) {
      const rows = await db.title.findMany({
        where: { id: { in: existing.map((entry) => entry.titleId) } },
        select: { id: true, fetchedAt: true, stale: true },
      });
      const cutoff = now().getTime() - CARD_TTL_MS;
      const due = new Set(
        rows
          .filter((row) => row.fetchedAt === null || row.stale || row.fetchedAt.getTime() < cutoff)
          .map((row) => row.id),
      );
      await mapLimit(
        existing.filter((entry) => due.has(entry.titleId)),
        RESOLVE_CONCURRENCY,
        (entry) => db.$transaction((tx) => applyCard(tx, entry.titleId, entry.item, now())),
      );
    }
    await linkSeasons(usable);
    // The same title can come back twice (two entries of a source mapped to one); show it once.
    return [...new Set(usable.map((entry) => entry.titleId))];
  }

  /**
   * A list page from AniList says how its titles relate (season 2 follows season 1). Store the links
   * whose far end is already a title of ours (usually another season on the same page) and let the
   * franchises follow, so a search shows "My Hero Academia" as one group at once instead of only
   * after each season has been opened. A failure here never fails the search.
   */
  async function linkSeasons(
    entries: readonly { titleId: string; item: SourceTitle }[],
  ): Promise<void> {
    try {
      const withLinks = entries.filter((entry) => (entry.item.relations?.length ?? 0) > 0);
      const wanted = new Set<string>();
      for (const entry of withLinks) {
        for (const relation of entry.item.relations ?? []) {
          const id = relation.target.externalIds.anilist;
          if (id !== undefined) wanted.add(id);
        }
      }
      if (wanted.size === 0) return;
      const known = await db.titleExternalId.findMany({
        where: { source: 'anilist', externalId: { in: [...wanted] } },
        select: { titleId: true, externalId: true },
      });
      const titleOf = new Map(known.map((row) => [row.externalId, row.titleId]));
      const rows = withLinks.flatMap((entry) =>
        (entry.item.relations ?? []).flatMap((relation) => {
          const to = titleOf.get(relation.target.externalIds.anilist ?? '');
          return to === undefined
            ? []
            : [{ fromTitleId: entry.titleId, toTitleId: to, relationType: relation.relationType }];
        }),
      );
      if (rows.length === 0) return;
      await db.$transaction(async (tx) => {
        await addRelations(tx, rows);
        await recomputeFranchises(tx, [...new Set(rows.map((row) => row.fromTitleId))]);
      });
    } catch (error) {
      logger.warn({ err: error }, 'could not link the seasons of a list page');
    }
  }

  function cacheGet(key: string): CachedPage | undefined {
    const hit = listCache.get(key);
    if (hit === undefined) return undefined;
    if (now().getTime() - hit.storedAt > LIST_CACHE_TTL_MS) {
      listCache.delete(key);
      return undefined;
    }
    return hit;
  }

  function cacheSet(key: string, page: Omit<CachedPage, 'storedAt'>): void {
    if (listCache.size >= LIST_CACHE_MAX) {
      const oldest = listCache.keys().next().value;
      if (oldest !== undefined) listCache.delete(oldest);
    }
    listCache.set(key, { ...page, storedAt: now().getTime() });
  }

  const CACHE_META: CatalogMeta = { stale: true, source: 'cache' };

  async function localList(
    userId: string,
    adult: boolean,
    ids: (offset: number, take: number) => Promise<string[]>,
    cursor: Cursor | undefined,
    limit: number,
    fallbackOffset: number,
  ): Promise<TitleListResponse> {
    const perPage = cursor?.k === 'local' ? cursor.perPage : Math.min(limit, 100);
    const offset = cursor?.k === 'local' ? cursor.offset : fallbackOffset;
    const found = await ids(offset, perPage + 1);
    if (found.length === 0 && offset === 0) throw sourcesUnavailable();
    const page = found.slice(0, perPage);
    return {
      data: await loadCards(db, page, userId, adult),
      nextCursor:
        found.length > perPage
          ? encodeCursor({ k: 'local', offset: offset + perPage, perPage })
          : null,
      meta: CACHE_META,
    };
  }

  /**
   * One page of a list: from the reuse cache, else from the sources; when no source can answer,
   * from Akiba's own copy, labelled stale (FR-DISC-010, NFR-REL-001).
   */
  async function list(
    userId: string,
    adult: boolean,
    key: string,
    query: { limit: number; cursor?: string | undefined },
    fetchPage: (page: PageRequest) => Promise<Sourced<SourcePage<SourceTitle>>>,
    local: (offset: number, take: number) => Promise<string[]>,
  ): Promise<TitleListResponse> {
    const cursor = decodeCursor(query.cursor);
    if (cursor?.k === 'local') return localList(userId, adult, local, cursor, query.limit, 0);

    const page = cursor?.page ?? 1;
    const perPage = cursor?.perPage ?? Math.min(query.limit, 50);
    const cacheKey = `${key}|${page}|${perPage}|${adult ? 'adult' : 'safe'}`;
    let cached = cacheGet(cacheKey);
    if (cached === undefined) {
      try {
        const sourced = await fetchPage({ page, perPage });
        const ids = await ingest(sourced.data.items, adult);
        cached = {
          ids,
          hasNextPage: sourced.data.hasNextPage,
          source: sourced.source,
          storedAt: 0,
        };
        cacheSet(cacheKey, cached);
      } catch (error) {
        if (!(error instanceof SourcesUnavailableError)) throw error;
        logger.warn(
          { causes: error.causes.map((cause) => cause.kind) },
          'catalog list served from cache',
        );
        return localList(userId, adult, local, undefined, query.limit, (page - 1) * perPage);
      }
    }
    return {
      data: await loadCards(db, cached.ids, userId, adult),
      nextCursor: cached.hasNextPage
        ? encodeCursor({ k: 'remote', page: page + 1, perPage })
        : null,
      meta: { stale: false, source: cached.source },
    };
  }

  const localFilters = (filters: {
    format?: string | undefined;
    status?: string | undefined;
    genre?: string | undefined;
    season?: string | undefined;
    year?: number | undefined;
    sort?: 'popularity' | 'score' | 'start_date' | undefined;
  }): LocalFilters => ({
    kind: filters.format,
    status: filters.status,
    genre: filters.genre,
    season: filters.season,
    seasonYear: filters.year,
    sort: filters.sort,
  });

  async function search(userId: string, query: SearchQuery): Promise<TitleListResponse> {
    const adult = await adultFor(userId);
    const filters = { format: query.format };
    return list(
      userId,
      adult,
      `search|${query.q.toLowerCase()}|${query.format ?? ''}`,
      query,
      (page) => gateway.search(query.q, toSourceFilters(adult, filters), page),
      (offset, take) =>
        localSearchIds(
          db,
          query.q,
          { ...localFilters(filters), includeAdult: adult },
          offset,
          take,
        ),
    );
  }

  async function browse(userId: string, query: BrowseQuery): Promise<TitleListResponse> {
    const adult = await adultFor(userId);
    const filters = {
      format: query.format,
      status: query.status,
      genre: query.genre,
      sort: query.sort,
      season: query.season,
      year: query.year,
    };
    return list(
      userId,
      adult,
      `browse|${JSON.stringify(filters)}`,
      query,
      (page) => gateway.browse(toSourceFilters(adult, filters), page),
      (offset, take) =>
        localBrowseIds(db, { ...localFilters(filters), includeAdult: adult }, offset, take),
    );
  }

  async function season(
    userId: string,
    year: number,
    seasonName: Season,
    query: SeasonQuery,
  ): Promise<SeasonListResponse> {
    const adult = await adultFor(userId);
    const filters = {
      format: query.format,
      genre: query.genre,
      sort: query.sort ?? ('popularity' as const),
      season: seasonName,
      year,
    };
    const result = await list(
      userId,
      adult,
      `season|${JSON.stringify(filters)}`,
      query,
      (page) => gateway.browse(toSourceFilters(adult, filters), page),
      (offset, take) =>
        localBrowseIds(db, { ...localFilters(filters), includeAdult: adult }, offset, take),
    );
    return { ...result, season: seasonName, seasonYear: year };
  }

  // ── One title ───────────────────────────────────────────────────────────────────

  const detailTtl = (status: string): number =>
    status === 'finished' || status === 'cancelled' ? DONE_DETAIL_TTL_MS : LIVE_DETAIL_TTL_MS;

  /** Fetch studios, relations and airing for a title and store them. `null` = the source has none. */
  function refreshDetail(titleId: string): Promise<SourceName | null> {
    const running = detailRefreshes.get(titleId);
    if (running !== undefined) return running;
    const work = (async (): Promise<SourceName | null> => {
      const rows = await db.titleExternalId.findMany({ where: { titleId } });
      const ids: ExternalIds = {};
      for (const row of rows) {
        if (row.source === 'anilist') ids.anilist = row.externalId;
        else if (row.source === 'mal') ids.mal = row.externalId;
      }
      const sourced = await gateway.getTitle(ids);
      const data = sourced.data;
      if (data === null) return sourced.source;

      // The source may report IDs we did not have (AniList knows the MAL ID): register them.
      await resolver.resolve({ externalIds: data.externalIds, title: data });

      const current = await db.title.findUniqueOrThrow({
        where: { id: titleId },
        select: { detailFetchedAt: true },
      });
      if (sourced.viaFallback && current.detailFetchedAt !== null) {
        // MAL's relations and studios must not replace what AniList told us earlier.
        await db.$transaction((tx) => applyCard(tx, titleId, data, now()));
        return sourced.source;
      }

      const related: {
        toTitleId: string;
        relationType: (typeof data.relations)[number]['relationType'];
      }[] = [];
      for (const relation of data.relations) {
        try {
          const target = await resolver.resolveRelationTarget(relation.target);
          related.push({ toTitleId: target.titleId, relationType: relation.relationType });
        } catch (error) {
          if (!(error instanceof UnresolvableTitleError)) throw error;
        }
      }
      await db.$transaction(async (tx) => {
        await applyDetail(tx, titleId, data, now());
        await replaceRelations(tx, titleId, related);
        // Franchises follow the relations, and the cast follows the detail (AniList only).
        await recomputeFranchises(tx, [titleId]);
        if (data.source === 'anilist') await replaceCharacters(tx, titleId, data.characters);
      });
      return sourced.source;
    })().finally(() => {
      detailRefreshes.delete(titleId);
    });
    detailRefreshes.set(titleId, work);
    return work;
  }

  /** Load a title, refreshing it first when our copy is missing or old; stale beats nothing. */
  async function ensureDetail(userId: string, titleId: string, adult: boolean) {
    if (!UUID.test(titleId)) throw notFound();
    let loaded = await loadDetail(db, titleId, userId, now(), adult);
    if (loaded === null) throw notFound();

    let meta: CatalogMeta = { stale: loaded.stale, source: 'cache' };
    const age =
      loaded.detailFetchedAt === null
        ? Infinity
        : now().getTime() - loaded.detailFetchedAt.getTime();
    if (age > detailTtl(loaded.status)) {
      try {
        const source = await refreshDetail(titleId);
        loaded = (await loadDetail(db, titleId, userId, now(), adult)) ?? loaded;
        meta = { stale: loaded.stale, source: source ?? 'cache' };
      } catch (error) {
        if (!(error instanceof SourcesUnavailableError)) throw error;
        if (loaded.fetchedAt === null) throw sourcesUnavailable(); // a placeholder with nothing to show
        await db.title.update({ where: { id: titleId }, data: { stale: true } });
        loaded = { ...loaded, stale: true };
        meta = CACHE_META;
        logger.warn(
          { titleId, causes: error.causes.map((cause) => cause.kind) },
          'title served stale',
        );
      }
    }
    return { loaded, meta };
  }

  async function detail(userId: string, titleId: string): Promise<TitleDetailResponse> {
    const { loaded, meta } = await ensureDetail(userId, titleId, await adultFor(userId));
    return { data: loaded.detail, meta };
  }

  async function relations(userId: string, titleId: string): Promise<RelationsResponse> {
    const adult = await adultFor(userId);
    const { meta } = await ensureDetail(userId, titleId, adult);
    const rows = await db.titleRelation.findMany({
      where: { fromTitleId: titleId },
      select: { relationType: true, toTitle: { select: { ...cardSelect(userId), isAdult: true } } },
    });
    const byType = new Map<string, ReturnType<typeof toCard>[]>();
    for (const row of rows) {
      if (row.toTitle.isAdult && !adult) continue;
      const list = byType.get(row.relationType) ?? [];
      list.push(toCard(row.toTitle));
      byType.set(row.relationType, list);
    }
    return {
      data: RELATION_TYPES.flatMap((relationType) => {
        const titles = byType.get(relationType);
        return titles === undefined || titles.length === 0
          ? []
          : [
              {
                relationType,
                titles: titles.sort(
                  (a, b) =>
                    (b.seasonYear ?? 0) - (a.seasonYear ?? 0) ||
                    (a.titleRomaji ?? '').localeCompare(b.titleRomaji ?? ''),
                ),
              },
            ];
      }),
      meta,
    };
  }

  async function characters(userId: string, titleId: string): Promise<TitleCharactersResponse> {
    const { loaded, meta: found } = await ensureDetail(userId, titleId, await adultFor(userId));
    let meta = found;
    let cast = await loadTitleCharacters(db, titleId);
    // A title fetched before casts were stored (or when AniList had none) is looked at again, at most hourly.
    const age =
      loaded.detailFetchedAt === null
        ? Infinity
        : now().getTime() - loaded.detailFetchedAt.getTime();
    if (cast.length === 0 && age > HOUR) {
      try {
        const source = await refreshDetail(titleId);
        cast = await loadTitleCharacters(db, titleId);
        meta = { stale: false, source: source ?? 'cache' };
      } catch (error) {
        if (!(error instanceof SourcesUnavailableError)) throw error; // the cache answer stands
      }
    }
    return { data: cast, meta };
  }

  async function refreshStale(limit: number): Promise<RefreshSummary> {
    const live = new Date(now().getTime() - LIVE_DETAIL_TTL_MS);
    const done = new Date(now().getTime() - DONE_DETAIL_TTL_MS);
    const rows = await db.title.findMany({
      where: {
        libraryEntries: { some: { removedAt: null } },
        OR: [
          { detailFetchedAt: null },
          { status: { in: ['finished', 'cancelled'] }, detailFetchedAt: { lt: done } },
          { status: { notIn: ['finished', 'cancelled'] }, detailFetchedAt: { lt: live } },
        ],
      },
      select: { id: true },
      orderBy: [{ detailFetchedAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
      take: limit,
    });
    let refreshed = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        await refreshDetail(row.id);
        refreshed += 1;
      } catch (error) {
        if (error instanceof SourcesUnavailableError) {
          return { candidates: rows.length, refreshed, failed, stopped: true };
        }
        failed += 1;
        logger.warn({ titleId: row.id, err: error }, 'metadata refresh failed for a title');
      }
    }
    return { candidates: rows.length, refreshed, failed, stopped: false };
  }

  // ── Genres ──────────────────────────────────────────────────────────────────────

  /** Adult-only genre labels never appear in pickers (Q-10). */
  const HIDDEN_GENRES = new Set(['hentai', 'erotica']);

  async function genres(): Promise<string[]> {
    const read = async (): Promise<string[]> =>
      (await db.genre.findMany({ select: { name: true }, orderBy: { name: 'asc' } }))
        .map((genre) => genre.name)
        .filter((name) => !HIDDEN_GENRES.has(name.toLowerCase()));

    const found = await read();
    if (found.length > 0) return found;
    // A fresh database has no genres until a source has been asked once.
    genreRefresh ??= (async () => {
      try {
        const sourced = await gateway.getGenres();
        await db.genre.createMany({
          data: sourced.data.map((name) => ({ name })),
          skipDuplicates: true,
        });
      } catch (error) {
        if (!(error instanceof SourcesUnavailableError)) throw error;
      }
    })().finally(() => {
      genreRefresh = undefined;
    });
    await genreRefresh;
    return read();
  }

  return {
    search,
    browse,
    season,
    currentSeason(userId, query) {
      const { season: name, year } = seasonOf(now());
      return season(userId, year, name, query);
    },
    detail,
    relations,
    characters,
    refreshStale,
    genres,
  };
}

// Re-exported for the tests that seed catalog rows the way the service would.
export { replaceGenres };
