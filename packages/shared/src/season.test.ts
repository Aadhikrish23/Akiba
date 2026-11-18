import { describe, expect, it } from 'vitest';
import { seasonOf, shiftSeason } from './season.js';

describe('seasons', () => {
  it.each([
    ['2026-01-01T00:00:00Z', 'winter'],
    ['2026-03-31T23:59:59Z', 'winter'],
    ['2026-04-01T00:00:00Z', 'spring'],
    ['2026-07-15T00:00:00Z', 'summer'],
    ['2026-10-01T00:00:00Z', 'fall'],
    ['2026-12-31T23:59:59Z', 'fall'],
  ])('%s is %s', (iso, season) => {
    expect(seasonOf(new Date(iso))).toEqual({ season, year: 2026 });
  });

  it('shifts across year boundaries in both directions', () => {
    expect(shiftSeason({ season: 'fall', year: 2026 }, 1)).toEqual({ season: 'winter', year: 2027 });
    expect(shiftSeason({ season: 'winter', year: 2026 }, -1)).toEqual({ season: 'fall', year: 2025 });
    expect(shiftSeason({ season: 'spring', year: 2026 }, 8)).toEqual({ season: 'spring', year: 2028 });
    expect(shiftSeason({ season: 'spring', year: 2026 }, 0)).toEqual({ season: 'spring', year: 2026 });
  });
});
