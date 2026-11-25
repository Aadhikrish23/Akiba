import {
  SourceError,
  type BreakerState,
  type ExternalIds,
  type PageRequest,
  type SourceAdapter,
  type SourceAiringEpisode,
  type SourceEpisode,
  type SourceName,
  type SourcePage,
  type SourceRelation,
  type SourceTitle,
  type SourceTitleDetail,
  type TitleFilters,
} from './types.js';

/** An answer, with the source that gave it. `viaFallback` tells the API to say `source: "jikan"`. */
export interface Sourced<T> {
  readonly data: T;
  readonly source: SourceName;
  readonly viaFallback: boolean;
}

/**
 * Neither the primary nor the fallback could answer. The caller (T12) turns this into a stale
 * cache answer where it has one, and into a 502/503 where it has not.
 */
export class SourcesUnavailableError extends Error {
  readonly causes: readonly SourceError[];

  constructor(causes: readonly SourceError[]) {
    super(
      `no metadata source could answer: ${causes.map((cause) => `${cause.source}:${cause.kind}`).join(', ')}`,
    );
    this.name = 'SourcesUnavailableError';
    this.causes = causes;
  }
}

export interface SourceGatewayOptions {
  readonly primary: SourceAdapter;
  readonly fallback?: SourceAdapter;
  readonly onFallback?: (event: {
    readonly operation: string;
    readonly primaryError: SourceError;
  }) => void;
}

export interface SourceStatus {
  readonly primary: { readonly name: SourceName; readonly breaker: BreakerState };
  readonly fallback: { readonly name: SourceName; readonly breaker: BreakerState } | null;
}

/**
 * Doc 05 §4 read flow, steps 2–3: ask the primary; when it fails (timeout, 429, 5xx, bad answer or
 * an open circuit) ask the fallback if it can answer that kind of question. A title that the
 * primary does not know (404) is NOT a failure and is not sent to the fallback.
 */
export class SourceGateway {
  readonly #primary: SourceAdapter;
  readonly #fallback: SourceAdapter | undefined;
  readonly #onFallback: SourceGatewayOptions['onFallback'];

  constructor(options: SourceGatewayOptions) {
    this.#primary = options.primary;
    this.#fallback = options.fallback;
    this.#onFallback = options.onFallback;
  }

  status(): SourceStatus {
    return {
      primary: { name: this.#primary.name, breaker: this.#primary.breakerState() },
      fallback:
        this.#fallback === undefined
          ? null
          : { name: this.#fallback.name, breaker: this.#fallback.breakerState() },
    };
  }

  /**
   * Run `operation` on the primary, then on the fallback. `usable` lets an operation skip an
   * adapter that cannot take part (no ID of its kind, or no support for the question).
   */
  async #read<T>(
    name: string,
    operation: (adapter: SourceAdapter) => Promise<T>,
    usable: (adapter: SourceAdapter) => boolean = () => true,
  ): Promise<Sourced<T>> {
    const failures: SourceError[] = [];
    const candidates = [this.#primary, this.#fallback].filter(
      (adapter): adapter is SourceAdapter => adapter !== undefined && usable(adapter),
    );
    for (const adapter of candidates) {
      try {
        return {
          data: await operation(adapter),
          source: adapter.name,
          viaFallback: adapter !== this.#primary,
        };
      } catch (error) {
        if (
          !(error instanceof SourceError) ||
          (!error.isFailure && error.kind !== 'circuit_open')
        ) {
          throw error;
        }
        failures.push(error);
        if (adapter === this.#primary && this.#onFallback !== undefined) {
          this.#onFallback({ operation: name, primaryError: error });
        }
      }
    }
    throw new SourcesUnavailableError(failures);
  }

  search(
    query: string,
    filters: TitleFilters,
    page: PageRequest,
  ): Promise<Sourced<SourcePage<SourceTitle>>> {
    return this.#read('search', (adapter) => adapter.search(query, filters, page));
  }

  browse(filters: TitleFilters, page: PageRequest): Promise<Sourced<SourcePage<SourceTitle>>> {
    return this.#read('browse', (adapter) => adapter.browse(filters, page));
  }

  /** `ids` are every ID known for the title; each adapter is asked with the ID it understands. */
  getTitle(ids: ExternalIds): Promise<Sourced<SourceTitleDetail | null>> {
    return this.#read(
      'getTitle',
      (adapter) => adapter.getTitle(idFor(adapter, ids) ?? ''),
      (adapter) => idFor(adapter, ids) !== undefined,
    );
  }

  getRelations(ids: ExternalIds): Promise<Sourced<readonly SourceRelation[]>> {
    return this.#read(
      'getRelations',
      (adapter) => adapter.getRelations(idFor(adapter, ids) ?? ''),
      (adapter) => idFor(adapter, ids) !== undefined,
    );
  }

  /** Airing schedules exist only at sources that publish them (AniList); there is no fallback. */
  getAiring(
    externalIds: readonly string[],
    from: Date,
    to: Date,
  ): Promise<Sourced<readonly SourceAiringEpisode[]>> {
    return this.#read(
      'getAiring',
      (adapter) => adapter.getAiring(externalIds, from, to),
      (adapter) => adapter.capabilities.airing,
    );
  }

  /** One episode's name and synopsis, from the sources that publish them (Jikan). */
  getEpisode(ids: ExternalIds, episode: number): Promise<Sourced<SourceEpisode | null>> {
    return this.#read(
      'getEpisode',
      (adapter) =>
        adapter.getEpisode?.(idFor(adapter, ids) ?? '', episode) ?? Promise.resolve(null),
      (adapter) => adapter.getEpisode !== undefined && idFor(adapter, ids) !== undefined,
    );
  }

  getGenres(): Promise<Sourced<readonly string[]>> {
    return this.#read('getGenres', (adapter) => adapter.getGenres());
  }
}

/** The ID an adapter understands: AniList takes AniList IDs, Jikan takes MyAnimeList IDs. */
function idFor(adapter: SourceAdapter, ids: ExternalIds): string | undefined {
  return adapter.name === 'anilist' ? ids.anilist : ids.mal;
}
