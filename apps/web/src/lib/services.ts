/**
 * Where the reader watches: the streaming services they have, kept on this device (like the theme).
 * A "Watch" button then goes to the first of these that carries the show.
 */

const KEY = 'akiba.services';

/** The services offered in Settings. Others AniList lists still show up on a title, under their own name. */
export const KNOWN_SERVICES = [
  'Crunchyroll',
  'Netflix',
  'Hulu',
  'Hotstar',
  'Prime Video',
  'Disney+',
  'HIDIVE',
  'YouTube',
] as const;

// Order matters: "Disney+ Hotstar" is Hotstar.
const ALIASES: readonly (readonly [RegExp, string])[] = [
  [/crunchyroll/i, 'Crunchyroll'],
  [/netflix/i, 'Netflix'],
  [/hulu/i, 'Hulu'],
  [/hotstar/i, 'Hotstar'],
  [/amazon|prime/i, 'Prime Video'],
  [/disney/i, 'Disney+'],
  [/hidive/i, 'HIDIVE'],
  [/youtube/i, 'YouTube'],
];

/** One name per service, whatever AniList calls it ("Amazon", "Disney Plus"…). */
export function serviceName(site: string): string {
  return ALIASES.find(([pattern]) => pattern.test(site))?.[1] ?? site;
}

export function readServices(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter((name): name is string => typeof name === 'string')
      : [];
  } catch {
    return [];
  }
}

export function saveServices(names: readonly string[]): void {
  try {
    if (names.length === 0) window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, JSON.stringify(names));
  } catch {
    // The choice still applies for this visit.
  }
}

/** A link to one episode itself, on the service that has it. */
export interface WatchChoiceData {
  readonly site: string;
  readonly href: string;
}

/**
 * Where to watch `episode`: only a link that opens that episode. AniList gives those for Crunchyroll
 * (where it lists them), and no streaming service publishes episode links we could use for the
 * rest, so every other service is left to the "Watch on" line of the season, which opens the show.
 * Never a show page and never a search. A reader who picked services and not Crunchyroll gets none.
 */
export function watchChoices(
  mine: readonly string[],
  crunchyrollEpisodes: Readonly<Record<string, string>>,
  episode: number,
): WatchChoiceData[] {
  const own = crunchyrollEpisodes[String(episode)];
  if (own === undefined || (mine.length > 0 && !mine.includes('Crunchyroll'))) return [];
  return [{ site: 'Crunchyroll', href: own }];
}

/** The services of a season that the reader has (all of them when none are picked). */
export function myServicesOf<T extends { readonly site: string }>(
  services: readonly T[],
  mine: readonly string[],
): T[] {
  return mine.length === 0
    ? [...services]
    : services.filter((service) => mine.includes(serviceName(service.site)));
}
