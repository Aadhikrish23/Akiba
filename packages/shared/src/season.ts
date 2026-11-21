import type { Season } from './titles.js';

/** Anime seasons by calendar quarter (the convention AniList and MAL both use). */
export function seasonOf(date: Date): { season: Season; year: number } {
  const month = date.getUTCMonth(); // 0–11
  const season: Season =
    month < 3 ? 'winter' : month < 6 ? 'spring' : month < 9 ? 'summer' : 'fall';
  return { season, year: date.getUTCFullYear() };
}

const ORDER: readonly Season[] = ['winter', 'spring', 'summer', 'fall'];

/** The season `steps` away from the given one (negative = earlier). */
export function shiftSeason(
  from: { season: Season; year: number },
  steps: number,
): { season: Season; year: number } {
  const index = from.year * 4 + ORDER.indexOf(from.season) + steps;
  return { season: ORDER[((index % 4) + 4) % 4] as Season, year: Math.floor(index / 4) };
}
