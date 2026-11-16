import type { ExternalSource, RelationType, Season, TitleKind, TitleStatus } from './index.js';

/**
 * Genres offered for browsing (the AniList genre list without its adult-only genre; adult
 * content is hidden by default, Q-10). Needed in every environment.
 */
export const SEED_GENRES = [
  'Action',
  'Adventure',
  'Comedy',
  'Drama',
  'Ecchi',
  'Fantasy',
  'Horror',
  'Mahou Shoujo',
  'Mecha',
  'Music',
  'Mystery',
  'Psychological',
  'Romance',
  'Sci-Fi',
  'Slice of Life',
  'Sports',
  'Supernatural',
  'Thriller',
] as const;

export type SeedGenre = (typeof SEED_GENRES)[number];

export interface SeedTitle {
  /** Stable handle used by `SEED_RELATIONS`; never stored. */
  readonly key: string;
  readonly kind: TitleKind;
  readonly titleRomaji: string;
  readonly titleEnglish: string | null;
  readonly titleNative: string | null;
  readonly synonyms: readonly string[];
  readonly synopsis: string;
  readonly status: TitleStatus;
  readonly episodesTotal: number | null;
  readonly durationMin: number | null;
  readonly season: Season | null;
  readonly seasonYear: number | null;
  /** ISO date (YYYY-MM-DD). */
  readonly startDate: string | null;
  readonly endDate: string | null;
  /** The first entry is the identity the seed uses to find the title again. */
  readonly externalIds: readonly [
    { readonly source: ExternalSource; readonly externalId: string },
    ...{ readonly source: ExternalSource; readonly externalId: string }[],
  ];
  readonly genres: readonly SeedGenre[];
  readonly studio: string;
}

/**
 * A small catalog for local development ONLY: enough rows to exercise external IDs, relations,
 * genres and studios before the source adapters exist. The values are hand-written samples, not
 * fetched or verified metadata; rows are created with `stale = true` and `fetched_at = NULL`, so
 * the first metadata refresh replaces them. Synopses are one-line placeholders written for this
 * file. Never loaded when NODE_ENV=production.
 */
export const SEED_TITLES: readonly SeedTitle[] = [
  {
    key: 'bebop-tv',
    kind: 'tv',
    titleRomaji: 'Cowboy Bebop',
    titleEnglish: 'Cowboy Bebop',
    titleNative: 'カウボーイビバップ',
    synonyms: [],
    synopsis: 'Development sample: bounty hunters drift through the solar system on the Bebop.',
    status: 'finished',
    episodesTotal: 26,
    durationMin: 24,
    season: 'spring',
    seasonYear: 1998,
    startDate: '1998-04-03',
    endDate: '1999-04-24',
    externalIds: [
      { source: 'anilist', externalId: '1' },
      { source: 'mal', externalId: '1' },
    ],
    genres: ['Action', 'Adventure', 'Drama', 'Sci-Fi'],
    studio: 'Sunrise',
  },
  {
    key: 'bebop-movie',
    kind: 'movie',
    titleRomaji: 'Cowboy Bebop: Tengoku no Tobira',
    titleEnglish: 'Cowboy Bebop: The Movie',
    titleNative: 'カウボーイビバップ 天国の扉',
    synonyms: ["Cowboy Bebop: Knockin' on Heaven's Door"],
    synopsis: 'Development sample: the Bebop crew chases a bounty on Mars.',
    status: 'finished',
    episodesTotal: 1,
    durationMin: 115,
    season: 'summer',
    seasonYear: 2001,
    startDate: '2001-09-01',
    endDate: '2001-09-01',
    externalIds: [
      { source: 'anilist', externalId: '5' },
      { source: 'mal', externalId: '5' },
    ],
    genres: ['Action', 'Drama', 'Mystery', 'Sci-Fi'],
    studio: 'Bones',
  },
  {
    key: 'fma-2003',
    kind: 'tv',
    titleRomaji: 'Hagane no Renkinjutsushi',
    titleEnglish: 'Fullmetal Alchemist',
    titleNative: '鋼の錬金術師',
    synonyms: ['FMA'],
    synopsis: 'Development sample: two brothers search for a way to restore their bodies.',
    status: 'finished',
    episodesTotal: 51,
    durationMin: 24,
    season: 'fall',
    seasonYear: 2003,
    startDate: '2003-10-04',
    endDate: '2004-10-02',
    externalIds: [
      { source: 'anilist', externalId: '121' },
      { source: 'mal', externalId: '121' },
    ],
    genres: ['Action', 'Adventure', 'Drama', 'Fantasy'],
    studio: 'Bones',
  },
  {
    key: 'fma-brotherhood',
    kind: 'tv',
    titleRomaji: 'Hagane no Renkinjutsushi: FULLMETAL ALCHEMIST',
    titleEnglish: 'Fullmetal Alchemist: Brotherhood',
    titleNative: '鋼の錬金術師 FULLMETAL ALCHEMIST',
    synonyms: ['FMAB'],
    synopsis: 'Development sample: a second adaptation that follows the manga to its end.',
    status: 'finished',
    episodesTotal: 64,
    durationMin: 24,
    season: 'spring',
    seasonYear: 2009,
    startDate: '2009-04-05',
    endDate: '2010-07-04',
    externalIds: [
      { source: 'anilist', externalId: '5114' },
      { source: 'mal', externalId: '5114' },
    ],
    genres: ['Action', 'Adventure', 'Drama', 'Fantasy'],
    studio: 'Bones',
  },
  {
    // Long-running and still airing: exercises "episode total unknown" in development.
    key: 'one-piece',
    kind: 'tv',
    titleRomaji: 'ONE PIECE',
    titleEnglish: 'ONE PIECE',
    titleNative: 'ONE PIECE',
    synonyms: ['OP'],
    synopsis: 'Development sample: a rubber-bodied pirate sails in search of a legendary treasure.',
    status: 'releasing',
    episodesTotal: null,
    durationMin: 24,
    season: 'fall',
    seasonYear: 1999,
    startDate: '1999-10-20',
    endDate: null,
    externalIds: [
      { source: 'anilist', externalId: '21' },
      { source: 'mal', externalId: '21' },
    ],
    genres: ['Action', 'Adventure', 'Comedy', 'Fantasy'],
    studio: 'Toei Animation',
  },
];

export interface SeedRelation {
  readonly from: string;
  readonly to: string;
  readonly relationType: RelationType;
}

/** Both directions are stored, as the sources report them. */
export const SEED_RELATIONS: readonly SeedRelation[] = [
  { from: 'bebop-tv', to: 'bebop-movie', relationType: 'side_story' },
  { from: 'bebop-movie', to: 'bebop-tv', relationType: 'parent_story' },
  { from: 'fma-2003', to: 'fma-brotherhood', relationType: 'alternative' },
  { from: 'fma-brotherhood', to: 'fma-2003', relationType: 'alternative' },
];
