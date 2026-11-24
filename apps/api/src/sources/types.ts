/**
 * The seam between Akiba and the metadata sources (NFR-MNT-003, doc 05 §4). Everything outside
 * `sources/` speaks these types; nothing outside it knows AniList's GraphQL or Jikan's REST.
 * Adapters are read-only and never see a user.
 */

/** State of a source's circuit breaker: closed is healthy, open is shut out, half_open is probing. */
export type BreakerState = 'closed' | 'open' | 'half_open';

export type SourceName = 'anilist' | 'jikan';

/** Which ID namespace a number belongs to. Jikan serves MyAnimeList data, so its IDs are `mal`. */
export type IdNamespace = 'anilist' | 'mal' | 'kitsu';

/** Every ID a source reported for one title (AniList also reports the MAL ID). */
export type ExternalIds = Partial<Record<IdNamespace, string>>;

export type TitleKind = 'tv' | 'movie' | 'ova' | 'ona' | 'special' | 'tv_short' | 'music';
export type TitleStatus = 'finished' | 'releasing' | 'not_yet_released' | 'cancelled' | 'hiatus';
export type Season = 'winter' | 'spring' | 'summer' | 'fall';
export type RelationKind =
  | 'prequel'
  | 'sequel'
  | 'side_story'
  | 'spin_off'
  | 'parent_story'
  | 'alternative'
  | 'adaptation'
  | 'summary'
  | 'other';

/** A date the source may only know in part (an announced "2027" has no month). */
export interface SourceDate {
  readonly year: number;
  readonly month: number | null;
  readonly day: number | null;
}

/** What search and browse return for each title: enough for a card. */
export interface SourceTitle {
  /** How the source says this title relates to others (AniList lists send them, so seasons can be grouped). */
  readonly relations?: readonly SourceRelation[];
  /** The Crunchyroll series page, when the source lists one (undefined: the source does not say). */
  readonly crunchyrollUrl?: string | null;
  /** Every streaming service the source lists for the show (undefined: the source does not say). */
  readonly streamingLinks?: readonly { readonly site: string; readonly url: string }[];
  readonly source: SourceName;
  readonly externalIds: ExternalIds;
  readonly kind: TitleKind;
  readonly titleRomaji: string | null;
  readonly titleEnglish: string | null;
  readonly titleNative: string | null;
  readonly synonyms: readonly string[];
  /** Plain text (markup removed). */
  readonly synopsis: string | null;
  readonly coverUrl: string | null;
  /** `#rrggbb`, lower case, or null when the source has no colour for the cover. */
  readonly coverColor: string | null;
  readonly bannerUrl: string | null;
  /** The source's own format label, verbatim. */
  readonly format: string | null;
  readonly status: TitleStatus;
  readonly episodesTotal: number | null;
  readonly durationMin: number | null;
  readonly season: Season | null;
  readonly seasonYear: number | null;
  readonly startDate: SourceDate | null;
  readonly endDate: SourceDate | null;
  /** 0–100. */
  readonly averageScore: number | null;
  readonly popularity: number | null;
  readonly isAdult: boolean;
  readonly genres: readonly string[];
  readonly sourceUpdatedAt: Date | null;
}

export interface SourceStudio {
  readonly externalId: string;
  readonly name: string;
  readonly isAnimationStudio: boolean;
  readonly isMain: boolean;
}

/** The title on the far side of a relation: enough to resolve it to an Akiba ID later. */
export interface SourceRelationTarget {
  readonly externalIds: ExternalIds;
  readonly kind: TitleKind | null;
  readonly title: string | null;
}

export interface SourceRelation {
  readonly relationType: RelationKind;
  readonly target: SourceRelationTarget;
}

export type CharacterRole = 'main' | 'supporting' | 'background';

/** A person who voices a character (the source's own ID; Akiba IDs come when it is stored). */
export interface SourceVoiceActor {
  readonly externalId: string;
  readonly name: string;
  readonly nativeName: string | null;
  readonly imageUrl: string | null;
  /** e.g. "Japanese". */
  readonly language: string;
}

export interface SourceCharacter {
  readonly externalId: string;
  readonly name: string;
  readonly nativeName: string | null;
  readonly imageUrl: string | null;
  /** Plain text, spoilers removed and capped. */
  readonly description: string | null;
  readonly role: CharacterRole;
  readonly voiceActors: readonly SourceVoiceActor[];
}

export interface SourceAiringSlot {
  readonly episode: number;
  readonly airsAt: Date;
}

export interface SourceTitleDetail extends SourceTitle {
  readonly studios: readonly SourceStudio[];
  readonly relations: readonly SourceRelation[];
  /** The main cast with their voice actors; empty when the source did not send any (Jikan's detail has none). */
  readonly characters: readonly SourceCharacter[];
  /** The next episode to air, when the source knows. */
  readonly nextAiring: SourceAiringSlot | null;
  /** Crunchyroll watch pages of single episodes, as far as the source lists them. */
  readonly crunchyrollEpisodes?: readonly { readonly episode: number; readonly url: string }[];
}

/** One scheduled episode of one title (the title is named in the ID namespace of its source). */
export interface SourceAiringEpisode extends SourceAiringSlot {
  readonly externalId: string;
}

export interface SourcePage<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly hasNextPage: boolean;
}

export interface PageRequest {
  /** 1-based. */
  readonly page: number;
  /** 1–50 (Jikan allows 25; the adapter clamps). */
  readonly perPage: number;
}

export type SortKey = 'popularity' | 'score' | 'newest';

export interface TitleFilters {
  readonly genre?: string;
  readonly season?: Season;
  readonly seasonYear?: number;
  readonly kind?: TitleKind;
  readonly status?: TitleStatus;
  readonly sort?: SortKey;
  /** Adult titles are left out unless this is true (Q-10). */
  readonly includeAdult?: boolean;
}

export interface SourceAdapter {
  readonly name: SourceName;
  /** What this source can answer; the gateway only asks for what is listed. */
  readonly capabilities: { readonly airing: boolean };
  /** Health of this source as the circuit breaker sees it. */
  breakerState(): BreakerState;
  search(query: string, filters: TitleFilters, page: PageRequest): Promise<SourcePage<SourceTitle>>;
  browse(filters: TitleFilters, page: PageRequest): Promise<SourcePage<SourceTitle>>;
  /** `null` when the source has no such title (or it is not an anime). */
  getTitle(externalId: string): Promise<SourceTitleDetail | null>;
  getRelations(externalId: string): Promise<readonly SourceRelation[]>;
  getAiring(
    externalIds: readonly string[],
    from: Date,
    to: Date,
  ): Promise<readonly SourceAiringEpisode[]>;
  getGenres(): Promise<readonly string[]>;
}

export type SourceErrorKind =
  /** No answer within the time limit. */
  | 'timeout'
  /** The source said slow down (HTTP 429). */
  | 'rate_limited'
  /** Network failure or a 5xx. */
  | 'unavailable'
  /** An answer that does not have the expected shape: an API change, not an outage. */
  | 'bad_response'
  /** The source has no such record. Not a failure of the source. */
  | 'not_found'
  /** The circuit breaker is open: no request was made. */
  | 'circuit_open'
  /** This source cannot answer that kind of question. */
  | 'unsupported';

/** Kinds that count against a source's health (and may be retried or answered by the fallback). */
export const SOURCE_FAILURE_KINDS: ReadonlySet<SourceErrorKind> = new Set([
  'timeout',
  'rate_limited',
  'unavailable',
  'bad_response',
]);

export class SourceError extends Error {
  readonly source: SourceName;
  readonly kind: SourceErrorKind;
  readonly status: number | undefined;
  /** The wait the source asked for (`Retry-After`), in ms. */
  readonly retryAfterMs: number | undefined;

  constructor(options: {
    readonly source: SourceName;
    readonly kind: SourceErrorKind;
    readonly message: string;
    readonly status?: number | undefined;
    readonly retryAfterMs?: number | undefined;
    readonly cause?: unknown;
  }) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SourceError';
    this.source = options.source;
    this.kind = options.kind;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }

  /** Whether this error says the source is unhealthy (as opposed to "no such title"). */
  get isFailure(): boolean {
    return SOURCE_FAILURE_KINDS.has(this.kind);
  }
}
