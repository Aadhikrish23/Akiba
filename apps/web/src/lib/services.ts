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

/** A way to watch one episode: its own page (`exact`) or the show's page on that service. */
export interface WatchChoiceData {
  readonly site: string;
  readonly href: string;
  readonly exact: boolean;
}

/**
 * Where to watch `episode`, on the services the reader has (all of them when none are chosen).
 * Crunchyroll can open the episode itself where AniList lists it; every other service opens the
 * show's page there. Episode-exact links come first, then the reader's own order. Never a search.
 */
export function watchChoices(
  services: readonly { readonly site: string; readonly url: string }[],
  mine: readonly string[],
  crunchyrollEpisodes: Readonly<Record<string, string>>,
  episode: number,
): WatchChoiceData[] {
  const wanted =
    mine.length === 0
      ? services
      : services.filter((service) => mine.includes(serviceName(service.site)));
  const seen = new Set<string>();
  const choices: WatchChoiceData[] = [];
  for (const service of wanted) {
    const site = serviceName(service.site);
    if (seen.has(site)) continue;
    seen.add(site);
    const own = site === 'Crunchyroll' ? crunchyrollEpisodes[String(episode)] : undefined;
    choices.push(
      own === undefined
        ? { site, href: service.url, exact: false }
        : { site, href: own, exact: true },
    );
  }
  const rank = (choice: WatchChoiceData): number => {
    const index = mine.indexOf(choice.site);
    return index < 0 ? mine.length : index;
  };
  return choices.sort((a, b) => Number(b.exact) - Number(a.exact) || rank(a) - rank(b));
}
