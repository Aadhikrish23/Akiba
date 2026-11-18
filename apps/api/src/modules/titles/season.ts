import type { Season } from '@akiba/shared';

/** Anime seasons by calendar quarter (the convention AniList and MAL both use). */
export function seasonOf(date: Date): { season: Season; year: number } {
  const month = date.getUTCMonth(); // 0–11
  const season: Season =
    month < 3 ? 'winter' : month < 6 ? 'spring' : month < 9 ? 'summer' : 'fall';
  return { season, year: date.getUTCFullYear() };
}

/** The season `steps` away from the given one (negative = earlier). */
export function shiftSeason(
  from: { season: Season; year: number },
  steps: number,
): { season: Season; year: number } {
  const order: Season[] = ['winter', 'spring', 'summer', 'fall'];
  const index = from.year * 4 + order.indexOf(from.season) + steps;
  return { season: order[((index % 4) + 4) % 4] as Season, year: Math.floor(index / 4) };
}
