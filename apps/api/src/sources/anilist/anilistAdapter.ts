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
  type SourceAiringEpisode,
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
import { AIRING_QUERY, GENRES_QUERY, MEDIA_DETAIL_QUERY, MEDIA_PAGE_QUERY } from './queries.js';

export const ANILIST_URL = 'https://graphql.anilist.co';

// ── What AniList sends (the parts Akiba reads) ────────────────────────────

const optionalString = z.string().nullish();
const optionalInt = z.number().int().nullish();
const dateSchema = z.object({ year: optionalInt, month: optionalInt, day: optionalInt }).nullish();

const mediaSchema = z.looseObject({
  id: z.number().int(),
  idMal: optionalInt,
  title: z
    .object({ romaji: optionalString, english: optionalString, native: optionalString })
    .nullish(),
  synonyms: z.array(z.string()).nullish(),
  description: optionalString,
  coverImage: z.object({ extraLarge: optionalString, large: optionalString }).nullish(),
  bannerImage: optionalString,
  format: optionalString,
  status: optionalString,
  episodes: optionalInt,
  duration: optionalInt,
  season: optionalString,
  seasonYear: optionalInt,
  startDate: dateSchema,
  endDate: dateSchema,
  averageScore: optionalInt,
  popularity: optionalInt,
  isAdult: z.boolean().nullish(),
  genres: z.array(z.string()).nullish(),
  updatedAt: optionalInt,
});
type Media = z.infer<typeof mediaSchema>;

const detailSchema = mediaSchema.extend({
  studios: z
    .object({
      edges: z.array(
        z.object({
          isMain: z.boolean().nullish(),
          node: z.object({
            id: z.number().int(),
            name: z.string(),
            isAnimationStudio: z.boolean().nullish(),
          }),
        }),
      ),
    })
    .nullish(),
  relations: z
    .object({
      edges: z.array(
        z.object({
          relationType: z.string().nullish(),
          node: z.object({
            id: z.number().int(),
            idMal: optionalInt,
            type: optionalString,
            format: optionalString,
            title: z.object({ romaji: optionalString }).nullish(),
          }),
        }),
      ),
    })
    .nullish(),
  nextAiringEpisode: z.object({ episode: z.number().int(), airingAt: z.number().int() }).nullish(),
});

const pageInfoSchema = z.object({
  currentPage: optionalInt,
  hasNextPage: z.boolean().nullish(),
});

const graphqlErrorsSchema = z.array(z.looseObject({ message: z.string().optional() })).optional();

// ── Mapping onto the Akiba vocabulary ─────────────────────────────────────

const KIND_BY_FORMAT: Readonly<Record<string, TitleKind>> = {
  TV: 'tv',
  TV_SHORT: 'tv_short',
  MOVIE: 'movie',
  SPECIAL: 'special',
  OVA: 'ova',
  ONA: 'ona',
  MUSIC: 'music',
};
const FORMAT_BY_KIND: Readonly<Record<TitleKind, string>> = {
  tv: 'TV',
  tv_short: 'TV_SHORT',
  movie: 'MOVIE',
  special: 'SPECIAL',
  ova: 'OVA',
  ona: 'ONA',
  music: 'MUSIC',
};

const STATUS_BY_SOURCE: Readonly<Record<string, TitleStatus>> = {
  FINISHED: 'finished',
  RELEASING: 'releasing',
  NOT_YET_RELEASED: 'not_yet_released',
  CANCELLED: 'cancelled',
  HIATUS: 'hiatus',
};

const SEASONS: ReadonlySet<string> = new Set(['winter', 'spring', 'summer', 'fall']);

const RELATION_BY_SOURCE: Readonly<Record<string, RelationKind>> = {
  PREQUEL: 'prequel',
  SEQUEL: 'sequel',
  PARENT: 'parent_story',
  SIDE_STORY: 'side_story',
  SPIN_OFF: 'spin_off',
  ALTERNATIVE: 'alternative',
  ADAPTATION: 'adaptation',
  SUMMARY: 'summary',
};

const SORT_BY_KEY = {
  popularity: 'POPULARITY_DESC',
  score: 'SCORE_DESC',
  newest: 'START_DATE_DESC',
} as const;

function toDate(value: z.infer<typeof dateSchema>): SourceDate | null {
  if (value === null || value === undefined) return null;
  const { year, month, day } = value;
  if (year === null || year === undefined) return null;
  return { year, month: month ?? null, day: day ?? null };
}

/** AniList "romaji", "english", "native" are Akiba's three display languages. */
export function normalizeMedia(media: Media): SourceTitle {
  const externalIds: SourceTitle['externalIds'] = {
    anilist: String(media.id),
    ...(media.idMal === null || media.idMal === undefined ? {} : { mal: String(media.idMal) }),
  };
  const season = media.season?.toLowerCase();
  return {
    source: 'anilist',
    externalIds,
    // A title that is only announced often has no format yet; "tv" is the safest guess and the
    // verbatim `format` stays null so nothing pretends to be known.
    kind: KIND_BY_FORMAT[media.format ?? ''] ?? 'tv',
    titleRomaji: cleanString(media.title?.romaji),
    titleEnglish: cleanString(media.title?.english),
    titleNative: cleanString(media.title?.native),
    synonyms: (media.synonyms ?? []).map((value) => value.trim()).filter((value) => value !== ''),
    synopsis: plainText(media.description),
    coverUrl: httpUrl(media.coverImage?.extraLarge) ?? httpUrl(media.coverImage?.large),
    bannerUrl: httpUrl(media.bannerImage),
    format: cleanString(media.format),
    status: STATUS_BY_SOURCE[media.status ?? ''] ?? 'not_yet_released',
    episodesTotal: intOrNull(media.episodes),
    durationMin: intOrNull(media.duration),
    season: season !== undefined && SEASONS.has(season) ? (season as Season) : null,
    seasonYear: intOrNull(media.seasonYear),
    startDate: toDate(media.startDate),
    endDate: toDate(media.endDate),
    averageScore: intOrNull(media.averageScore),
    popularity: intOrNull(media.popularity),
    isAdult: media.isAdult === true,
    genres: media.genres ?? [],
    sourceUpdatedAt:
      media.updatedAt === null || media.updatedAt === undefined
        ? null
        : new Date(media.updatedAt * 1000),
  };
}

function normalizeDetail(media: z.infer<typeof detailSchema>): SourceTitleDetail {
  const studios: SourceStudio[] = (media.studios?.edges ?? []).map((edge) => ({
    externalId: String(edge.node.id),
    name: edge.node.name,
    isAnimationStudio: edge.node.isAnimationStudio === true,
    isMain: edge.isMain === true,
  }));
  return {
    ...normalizeMedia(media),
    studios,
    relations: normalizeRelations(media),
    nextAiring:
      media.nextAiringEpisode === null || media.nextAiringEpisode === undefined
        ? null
        : {
            episode: media.nextAiringEpisode.episode,
            airsAt: new Date(media.nextAiringEpisode.airingAt * 1000),
          },
  };
}

function normalizeRelations(media: z.infer<typeof detailSchema>): SourceRelation[] {
  const relations: SourceRelation[] = [];
  for (const edge of media.relations?.edges ?? []) {
    // Manga and novels are not titles in Akiba; an "adaptation" of one is not a relation here.
    if (edge.node.type !== 'ANIME') continue;
    relations.push({
      relationType: RELATION_BY_SOURCE[edge.relationType ?? ''] ?? 'other',
      target: {
        externalIds: {
          anilist: String(edge.node.id),
          ...(edge.node.idMal === null || edge.node.idMal === undefined
            ? {}
            : { mal: String(edge.node.idMal) }),
        },
        kind:
          edge.node.format === null || edge.node.format === undefined
            ? null
            : (KIND_BY_FORMAT[edge.node.format] ?? null),
        title: cleanString(edge.node.title?.romaji),
      },
    });
  }
  return relations;
}

// ── The adapter ───────────────────────────────────────────────────────────

export interface AniListAdapterOptions {
  readonly url?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: Clock;
  readonly sleep?: Sleep;
  readonly random?: () => number;
  /** Requests per minute to stay under (AniList currently allows 30). Default 30. */
  readonly requestsPerMinute?: number;
  readonly userAgent?: string;
  readonly breaker?: CircuitBreaker;
}

const MAX_AIRING_PAGES = 10;

export function createAniListAdapter(options: AniListAdapterOptions = {}): SourceAdapter {
  const url = options.url ?? ANILIST_URL;
  const perMinute = options.requestsPerMinute ?? 30;
  const httpJson = createHttpJson({
    source: 'anilist',
    timeoutMs: options.timeoutMs ?? 5_000,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
  });
  const breaker =
    options.breaker ??
    new CircuitBreaker({
      source: 'anilist',
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  const client = createResilientClient({
    source: 'anilist',
    bucket: new TokenBucket({
      capacity: Math.max(1, Math.min(10, perMinute)),
      refillPerSecond: perMinute / 60,
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
    breaker,
    sleep: options.sleep ?? realSleep,
    ...(options.random === undefined ? {} : { random: options.random }),
  });

  /** One GraphQL call: returns `data`, or throws a classified {@link SourceError}. */
  async function graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
    const { status, json } = await httpJson(url, { method: 'POST', body: { query, variables } });
    const body = z
      .looseObject({ data: z.unknown().optional(), errors: graphqlErrorsSchema })
      .safeParse(json);
    if (!body.success) {
      throw new SourceError({
        source: 'anilist',
        kind: 'bad_response',
        message: 'anilist answered with something that is not a GraphQL response',
        status,
      });
    }
    const errors = body.data.errors ?? [];
    if (errors.length > 0) {
      const notFound = errors.some((error) => (error as { status?: unknown }).status === 404);
      throw new SourceError({
        source: 'anilist',
        kind: notFound ? 'not_found' : 'bad_response',
        message: `anilist returned ${errors.length} GraphQL error(s)`,
        status,
      });
    }
    if (status >= 400 || body.data.data === undefined || body.data.data === null) {
      throw new SourceError({
        source: 'anilist',
        kind: 'bad_response',
        message: `anilist answered ${status} without data`,
        status,
      });
    }
    return body.data.data;
  }

  const parse = <T>(schema: z.ZodType<T>, value: unknown, what: string): T => {
    const result = schema.safeParse(value);
    if (!result.success) {
      throw new SourceError({
        source: 'anilist',
        kind: 'bad_response',
        message: `anilist ${what} does not match the expected shape`,
        cause: result.error,
      });
    }
    return result.data;
  };

  function variablesFor(
    query: string | undefined,
    filters: TitleFilters,
    page: PageRequest,
  ): Record<string, unknown> {
    const sort =
      filters.sort !== undefined
        ? SORT_BY_KEY[filters.sort]
        : query === undefined
          ? 'POPULARITY_DESC'
          : 'SEARCH_MATCH';
    return {
      page: page.page,
      perPage: Math.min(50, Math.max(1, page.perPage)),
      search: query,
      genre: filters.genre,
      season: filters.season?.toUpperCase(),
      seasonYear: filters.seasonYear,
      format: filters.kind === undefined ? undefined : FORMAT_BY_KIND[filters.kind],
      status: filters.status?.toUpperCase(),
      // Adult titles are left out unless asked for (Q-10); omitting the variable returns both.
      isAdult: filters.includeAdult === true ? undefined : false,
      sort: [sort],
    };
  }

  const pageSchema = z.object({
    Page: z.object({ pageInfo: pageInfoSchema, media: z.array(mediaSchema) }),
  });

  async function pageOf(
    key: string,
    variables: Record<string, unknown>,
  ): Promise<SourcePage<SourceTitle>> {
    const data = await client.run(key, () => graphql(MEDIA_PAGE_QUERY, variables));
    const { Page } = parse(pageSchema, data, 'page');
    return {
      items: Page.media.map(normalizeMedia),
      page: Page.pageInfo.currentPage ?? (variables['page'] as number),
      hasNextPage: Page.pageInfo.hasNextPage === true,
    };
  }

  async function detail(externalId: string): Promise<SourceTitleDetail | null> {
    const id = Number(externalId);
    if (!Number.isInteger(id) || id <= 0) return null;
    try {
      const data = await client.run(`detail:${id}`, () => graphql(MEDIA_DETAIL_QUERY, { id }));
      const { Media } = parse(z.object({ Media: detailSchema }), data, 'detail');
      return normalizeDetail(Media);
    } catch (error) {
      if (error instanceof SourceError && error.kind === 'not_found') return null;
      throw error;
    }
  }

  return {
    name: 'anilist',
    capabilities: { airing: true },
    breakerState: () => breaker.state,

    search(query, filters, page) {
      const variables = variablesFor(query, filters, page);
      return pageOf(`search:${JSON.stringify(variables)}`, variables);
    },

    browse(filters, page) {
      const variables = variablesFor(undefined, filters, page);
      return pageOf(`browse:${JSON.stringify(variables)}`, variables);
    },

    getTitle: detail,

    async getRelations(externalId) {
      const found = await detail(externalId);
      return found?.relations ?? [];
    },

    async getAiring(externalIds, from, to) {
      const ids = externalIds.map(Number).filter((id) => Number.isInteger(id) && id > 0);
      if (ids.length === 0) return [];
      const schema = z.object({
        Page: z.object({
          pageInfo: pageInfoSchema,
          airingSchedules: z.array(
            z.object({
              episode: z.number().int(),
              airingAt: z.number().int(),
              mediaId: z.number().int(),
            }),
          ),
        }),
      });
      const episodes: SourceAiringEpisode[] = [];
      for (let page = 1; page <= MAX_AIRING_PAGES; page += 1) {
        const variables = {
          ids,
          from: Math.floor(from.getTime() / 1000),
          to: Math.floor(to.getTime() / 1000),
          page,
          perPage: 50,
        };
        const data = await client.run(`airing:${JSON.stringify(variables)}`, () =>
          graphql(AIRING_QUERY, variables),
        );
        const { Page } = parse(schema, data, 'airing page');
        for (const slot of Page.airingSchedules) {
          episodes.push({
            externalId: String(slot.mediaId),
            episode: slot.episode,
            airsAt: new Date(slot.airingAt * 1000),
          });
        }
        if (Page.pageInfo.hasNextPage !== true) break;
      }
      return episodes;
    },

    async getGenres() {
      const data = await client.run('genres', () => graphql(GENRES_QUERY, {}));
      return parse(z.object({ GenreCollection: z.array(z.string()) }), data, 'genres')
        .GenreCollection;
    },
  };
}
