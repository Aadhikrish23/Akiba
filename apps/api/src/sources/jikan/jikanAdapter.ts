import { z } from 'zod';
import {
  CircuitBreaker,
  TokenBucket,
  createHttpJson,
  createResilientClient,
  realSleep,
  type Clock,
  type Sleep,
} from '../resilience.js';
import { cleanString, httpUrl, intOrNull, plainText } from '../text.js';
import {
  SourceError,
  type PageRequest,
  type RelationKind,
  type Season,
  type SourceAdapter,
  type SourceDate,
  type SourcePage,
  type SourceRelation,
  type SourceStudio,
  type SourceTitle,
  type SourceTitleDetail,
  type TitleFilters,
  type TitleKind,
  type TitleStatus,
} from '../types.js';

export const JIKAN_URL = 'https://api.jikan.moe/v4';

// ── What Jikan (MyAnimeList) sends ────────────────────────────────────────

const namedSchema = z.object({ mal_id: z.number().int(), name: z.string() });
const dateParts = z
  .object({
    day: z.number().int().nullish(),
    month: z.number().int().nullish(),
    year: z.number().int().nullish(),
  })
  .nullish();

const animeSchema = z.looseObject({
  mal_id: z.number().int(),
  title: z.string().nullish(),
  title_english: z.string().nullish(),
  title_japanese: z.string().nullish(),
  title_synonyms: z.array(z.string()).nullish(),
  type: z.string().nullish(),
  status: z.string().nullish(),
  episodes: z.number().int().nullish(),
  duration: z.string().nullish(),
  rating: z.string().nullish(),
  score: z.number().nullish(),
  popularity: z.number().int().nullish(),
  synopsis: z.string().nullish(),
  season: z.string().nullish(),
  year: z.number().int().nullish(),
  aired: z.object({ prop: z.object({ from: dateParts, to: dateParts }).nullish() }).nullish(),
  images: z
    .object({
      jpg: z
        .object({ image_url: z.string().nullish(), large_image_url: z.string().nullish() })
        .nullish(),
    })
    .nullish(),
  genres: z.array(namedSchema).nullish(),
  explicit_genres: z.array(namedSchema).nullish(),
  studios: z.array(namedSchema).nullish(),
  relations: z
    .array(
      z.object({
        relation: z.string(),
        entry: z.array(z.object({ mal_id: z.number().int(), type: z.string(), name: z.string() })),
      }),
    )
    .nullish(),
});
type Anime = z.infer<typeof animeSchema>;

const paginationSchema = z.object({
  current_page: z.number().int().nullish(),
  has_next_page: z.boolean().nullish(),
});

// ── Mapping onto the Akiba vocabulary ─────────────────────────────────────

/** `null` means "not an anime title Akiba tracks" (commercials, promo videos). */
const KIND_BY_TYPE: Readonly<Record<string, TitleKind>> = {
  tv: 'tv',
  movie: 'movie',
  ova: 'ova',
  ona: 'ona',
  special: 'special',
  'tv special': 'special',
  music: 'music',
};

const TYPE_BY_KIND: Readonly<Partial<Record<TitleKind, string>>> = {
  tv: 'tv',
  movie: 'movie',
  ova: 'ova',
  ona: 'ona',
  special: 'special',
  music: 'music',
};

const STATUS_BY_SOURCE: Readonly<Record<string, TitleStatus>> = {
  'finished airing': 'finished',
  'currently airing': 'releasing',
  'not yet aired': 'not_yet_released',
};

const STATUS_QUERY: Readonly<Partial<Record<TitleStatus, string>>> = {
  finished: 'complete',
  releasing: 'airing',
  not_yet_released: 'upcoming',
};

const RELATION_BY_LABEL: Readonly<Record<string, RelationKind>> = {
  sequel: 'sequel',
  prequel: 'prequel',
  'side story': 'side_story',
  'spin-off': 'spin_off',
  'parent story': 'parent_story',
  'full story': 'parent_story',
  'alternative version': 'alternative',
  'alternative setting': 'alternative',
  summary: 'summary',
  adaptation: 'adaptation',
};

const SEASONS: ReadonlySet<string> = new Set(['winter', 'spring', 'summer', 'fall']);
const ADULT_GENRES: ReadonlySet<string> = new Set(['hentai', 'erotica']);

function toDate(parts: z.infer<typeof dateParts>): SourceDate | null {
  if (parts === null || parts === undefined) return null;
  if (parts.year === null || parts.year === undefined) return null;
  return { year: parts.year, month: parts.month ?? null, day: parts.day ?? null };
}

/** "24 min per ep" → 24, "1 hr 55 min" → 115, anything else → null. */
export function parseDurationMinutes(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const hours = /(\d+)\s*hr/.exec(value);
  const minutes = /(\d+)\s*min/.exec(value);
  if (hours === null && minutes === null) return null;
  return Number(hours?.[1] ?? 0) * 60 + Number(minutes?.[1] ?? 0);
}

/** `null` for a record that is not a title Akiba tracks. */
export function normalizeAnime(anime: Anime): SourceTitle | null {
  const kind = KIND_BY_TYPE[(anime.type ?? '').toLowerCase()];
  if (kind === undefined) return null;
  const season = anime.season?.toLowerCase();
  const genres = [...(anime.genres ?? []), ...(anime.explicit_genres ?? [])];
  return {
    source: 'jikan',
    externalIds: { mal: String(anime.mal_id) },
    kind,
    // MAL's default title is the romaji one.
    titleRomaji: cleanString(anime.title),
    titleEnglish: cleanString(anime.title_english),
    titleNative: cleanString(anime.title_japanese),
    synonyms: (anime.title_synonyms ?? []).map((value) => value.trim()).filter((v) => v !== ''),
    synopsis: plainText(anime.synopsis),
    coverUrl: httpUrl(anime.images?.jpg?.large_image_url) ?? httpUrl(anime.images?.jpg?.image_url),
    coverColor: null,
    bannerUrl: null,
    format: cleanString(anime.type),
    status: STATUS_BY_SOURCE[(anime.status ?? '').toLowerCase()] ?? 'not_yet_released',
    episodesTotal: intOrNull(anime.episodes),
    durationMin: parseDurationMinutes(anime.duration),
    season: season !== undefined && SEASONS.has(season) ? (season as Season) : null,
    seasonYear: intOrNull(anime.year),
    startDate: toDate(anime.aired?.prop?.from),
    endDate: toDate(anime.aired?.prop?.to),
    // MAL scores are 0–10 with two decimals; Akiba keeps 0–100 integers.
    averageScore:
      anime.score === null || anime.score === undefined ? null : Math.round(anime.score * 10),
    popularity: intOrNull(anime.popularity),
    isAdult:
      (anime.rating ?? '').toLowerCase().startsWith('rx') ||
      genres.some((genre) => ADULT_GENRES.has(genre.name.toLowerCase())),
    genres: (anime.genres ?? []).map((genre) => genre.name),
    sourceUpdatedAt: null,
  };
}

function normalizeRelations(anime: Anime): SourceRelation[] {
  const relations: SourceRelation[] = [];
  for (const group of anime.relations ?? []) {
    const relationType = RELATION_BY_LABEL[group.relation.toLowerCase()] ?? 'other';
    for (const entry of group.entry) {
      // Manga and light novels are listed in the same groups; they are not titles here.
      if (entry.type.toLowerCase() !== 'anime') continue;
      relations.push({
        relationType,
        target: { externalIds: { mal: String(entry.mal_id) }, kind: null, title: entry.name },
      });
    }
  }
  return relations;
}

function normalizeDetail(anime: Anime): SourceTitleDetail | null {
  const base = normalizeAnime(anime);
  if (base === null) return null;
  const studios: SourceStudio[] = (anime.studios ?? []).map((studio, index) => ({
    externalId: String(studio.mal_id),
    name: studio.name,
    // MAL lists producers and licensors apart from studios, so this list is animation studios.
    isAnimationStudio: true,
    isMain: index === 0,
  }));
  // MAL does not publish the next episode's time; the airing schedule is AniList-only.
  return {
    ...base,
    studios,
    relations: normalizeRelations(anime),
    characters: [],
    nextAiring: null,
  };
}

// ── The adapter ───────────────────────────────────────────────────────────

export interface JikanAdapterOptions {
  readonly url?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: Clock;
  readonly sleep?: Sleep;
  readonly random?: () => number;
  /** Jikan allows 3 requests/s and 60/min. Default 60. */
  readonly requestsPerMinute?: number;
  readonly userAgent?: string;
  readonly breaker?: CircuitBreaker;
}

const MAX_PER_PAGE = 25;

export function createJikanAdapter(options: JikanAdapterOptions = {}): SourceAdapter {
  const base = (options.url ?? JIKAN_URL).replace(/\/+$/, '');
  const perMinute = options.requestsPerMinute ?? 60;
  const httpJson = createHttpJson({
    source: 'jikan',
    timeoutMs: options.timeoutMs ?? 5_000,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
  });
  const breaker =
    options.breaker ??
    new CircuitBreaker({
      source: 'jikan',
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  const client = createResilientClient({
    source: 'jikan',
    bucket: new TokenBucket({
      capacity: 3,
      refillPerSecond: perMinute / 60,
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
    breaker,
    sleep: options.sleep ?? realSleep,
    ...(options.random === undefined ? {} : { random: options.random }),
  });

  async function get(path: string, params: Record<string, string | number | undefined> = {}) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) query.set(key, String(value));
    }
    const suffix = query.size === 0 ? '' : `?${query.toString()}`;
    const url = `${base}${path}${suffix}`;
    return client.run(url, async () => {
      const { status, json } = await httpJson(url);
      if (status >= 400) {
        throw new SourceError({
          source: 'jikan',
          kind: 'bad_response',
          message: `jikan answered ${status}`,
          status,
        });
      }
      return json;
    });
  }

  const parse = <T>(schema: z.ZodType<T>, value: unknown, what: string): T => {
    const result = schema.safeParse(value);
    if (!result.success) {
      throw new SourceError({
        source: 'jikan',
        kind: 'bad_response',
        message: `jikan ${what} does not match the expected shape`,
        cause: result.error,
      });
    }
    return result.data;
  };

  const listSchema = z.object({
    data: z.array(animeSchema),
    pagination: paginationSchema.nullish(),
  });

  let genreIds: Promise<ReadonlyMap<string, number>> | undefined;
  const loadGenreIds = (): Promise<ReadonlyMap<string, number>> => {
    genreIds ??= get('/genres/anime')
      .then((json) => {
        const { data } = parse(z.object({ data: z.array(namedSchema) }), json, 'genres');
        return new Map(data.map((genre) => [genre.name.toLowerCase(), genre.mal_id] as const));
      })
      .catch((error: unknown) => {
        genreIds = undefined; // a failed load must not stick
        throw error;
      });
    return genreIds;
  };

  async function listing(
    path: string,
    params: Record<string, string | number | undefined>,
    page: PageRequest,
  ): Promise<SourcePage<SourceTitle>> {
    const json = await get(path, {
      ...params,
      page: page.page,
      limit: Math.min(MAX_PER_PAGE, Math.max(1, page.perPage)),
    });
    const body = parse(listSchema, json, 'listing');
    const items: SourceTitle[] = [];
    for (const anime of body.data) {
      const title = normalizeAnime(anime);
      if (title !== null) items.push(title);
    }
    return {
      items,
      page: body.pagination?.current_page ?? page.page,
      hasNextPage: body.pagination?.has_next_page === true,
    };
  }

  const emptyPage = (page: PageRequest): SourcePage<SourceTitle> => ({
    items: [],
    page: page.page,
    hasNextPage: false,
  });

  /** Query parameters shared by `/anime` and `/seasons/…` (filters Jikan can express). */
  async function filterParams(
    filters: TitleFilters,
  ): Promise<Record<string, string | number | undefined> | null> {
    let genres: number | undefined;
    if (filters.genre !== undefined) {
      const id = (await loadGenreIds()).get(filters.genre.toLowerCase());
      if (id === undefined) return null; // an unknown genre matches nothing
      genres = id;
    }
    const order =
      filters.sort === 'score'
        ? { order_by: 'score', sort: 'desc' }
        : filters.sort === 'newest'
          ? { order_by: 'start_date', sort: 'desc' }
          : { order_by: 'popularity', sort: 'asc' };
    return {
      ...order,
      genres,
      type: filters.kind === undefined ? undefined : TYPE_BY_KIND[filters.kind],
      status: filters.status === undefined ? undefined : STATUS_QUERY[filters.status],
      sfw: filters.includeAdult === true ? undefined : 'true',
    };
  }

  async function getTitle(externalId: string): Promise<SourceTitleDetail | null> {
    const id = Number(externalId);
    if (!Number.isInteger(id) || id <= 0) return null;
    try {
      const json = await get(`/anime/${id}/full`);
      const { data } = parse(z.object({ data: animeSchema }), json, 'detail');
      return normalizeDetail(data);
    } catch (error) {
      if (error instanceof SourceError && error.kind === 'not_found') return null;
      throw error;
    }
  }

  return {
    name: 'jikan',
    // MAL publishes no per-episode air times.
    capabilities: { airing: false },
    breakerState: () => breaker.state,

    async search(query, filters, page) {
      const params = await filterParams(filters);
      if (params === null) return emptyPage(page);
      // Relevance order is the default for a text search; only an explicit sort overrides it.
      if (filters.sort === undefined) {
        delete params['order_by'];
        delete params['sort'];
      }
      return listing('/anime', { ...params, q: query }, page);
    },

    async browse(filters, page) {
      const params = await filterParams(filters);
      if (params === null) return emptyPage(page);
      if (filters.season !== undefined && filters.seasonYear !== undefined) {
        // The season endpoint orders itself and takes neither genre, type nor status filters,
        // so those do not apply to a season listing from this source.
        const { sfw } = params;
        return listing(`/seasons/${filters.seasonYear}/${filters.season}`, { sfw }, page);
      }
      return listing('/anime', params, page);
    },

    getTitle,

    async getRelations(externalId) {
      const found = await getTitle(externalId);
      return found?.relations ?? [];
    },

    getAiring() {
      return Promise.reject(
        new SourceError({
          source: 'jikan',
          kind: 'unsupported',
          message: 'jikan has no airing schedule per title',
        }),
      );
    },

    async getEpisode(externalId, episode) {
      const id = Number(externalId);
      if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(episode) || episode <= 0) {
        return null;
      }
      let json: unknown;
      try {
        json = await get(`/anime/${id}/episodes/${episode}`);
      } catch (error) {
        // Jikan has no such episode (or no episode list for the show): nothing to say, not a failure.
        if (error instanceof SourceError && error.status === 404) return null;
        throw error;
      }
      const { data } = parse(
        z.object({
          data: z.object({
            title: z.string().nullish(),
            synopsis: z.string().nullish(),
          }),
        }),
        json,
        'episode',
      );
      const name = cleanString(data.title);
      const synopsis = plainText(data.synopsis);
      return name === null && synopsis === null ? null : { episode, name, synopsis };
    },

    async getGenres() {
      const json = await get('/genres/anime');
      return parse(z.object({ data: z.array(namedSchema) }), json, 'genres')
        .data.map((genre) => genre.name)
        .filter((name) => !ADULT_GENRES.has(name.toLowerCase()));
    },
  };
}
