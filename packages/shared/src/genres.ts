/**
 * Genres that are only offered when the reader turned adult titles on in Settings (Q-10): the kind
 * of thing streaming services carry behind a mature-content gate. "Ecchi" is an AniList genre; the
 * rest are AniList tags, which Akiba keeps beside the genres of each title.
 */
export const ADULT_GENRES = [
  'Ecchi',
  'Harem',
  'Reverse Harem',
  'Nudity',
  'Gore',
  'Erotica',
] as const;

/** The adult genres that AniList knows as tags rather than genres (filtered with `tag`, not `genre`). */
export const ADULT_TAG_GENRES: readonly string[] = ['Harem', 'Reverse Harem', 'Nudity', 'Gore'];

/** Explicit pornographic content: never offered as a genre and never listed, in any setting. */
export const EXPLICIT_GENRES: readonly string[] = ['Hentai'];

const lower = (names: readonly string[]): Set<string> => new Set(names.map((n) => n.toLowerCase()));
const ADULT = lower(ADULT_GENRES);
const EXPLICIT = lower(EXPLICIT_GENRES);

export const isAdultGenre = (name: string): boolean => ADULT.has(name.toLowerCase());
export const isExplicitGenre = (name: string): boolean => EXPLICIT.has(name.toLowerCase());
export const isAdultTagGenre = (name: string): boolean =>
  ADULT_TAG_GENRES.some((tag) => tag.toLowerCase() === name.toLowerCase());
