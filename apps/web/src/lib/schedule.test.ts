import type { ScheduleSlot } from '@akiba/shared';
import { describe, expect, it } from 'vitest';
import {
  addMonths,
  clock,
  daysBetween,
  monthGrid,
  mondayOf,
  mondayOfDate,
  place,
  safeZone,
  startOfDay,
  stateOf,
} from './schedule';
import { stockFor } from './stock';

const slotAt = (airsAt: string, extra: Partial<ScheduleSlot> = {}): ScheduleSlot => ({
  entryId: '11111111-1111-4111-8111-111111111111',
  title: {
    id: '00000000-0000-4000-8000-000000000001',
    kind: 'tv',
    titleRomaji: 'Show',
    titleEnglish: null,
    titleNative: null,
    coverUrl: null,
    coverColor: null,
    franchise: null,
    crunchyrollUrl: null,
    format: 'TV',
    status: 'releasing',
    episodesTotal: 12,
    season: 'fall',
    seasonYear: 2026,
    averageScore: null,
    libraryStatus: 'watching',
    libraryEntryId: '11111111-1111-4111-8111-111111111111',
  },
  entryStatus: 'watching',
  episode: 8,
  airsAt,
  projected: false,
  progress: 7,
  watched: false,
  ...extra,
});

describe('broadcast time (doc 08 §1)', () => {
  // Monday 23 Nov 2026
  const monday = { y: 2026, m: 11, d: 23 };

  it('writes an evening episode on its own day', () => {
    const placed = place(slotAt('2026-11-24T22:00:00.000Z'), monday, 'UTC');
    expect(placed).toMatchObject({ dayIndex: 1, hour: 22, minute: 0 });
    expect(clock(placed)).toBe('22:00');
  });

  it('writes 1:30 am on Wednesday as 25:30 on Tuesday', () => {
    const placed = place(slotAt('2026-11-25T01:30:00.000Z'), monday, 'UTC');
    expect(placed).toMatchObject({ dayIndex: 1, hour: 25, minute: 30 });
    expect(clock(placed)).toBe('25:30');
  });

  it('keeps 6:00 am on its own morning: the late night ends before it', () => {
    expect(place(slotAt('2026-11-25T06:00:00.000Z'), monday, 'UTC')).toMatchObject({
      dayIndex: 2,
      hour: 6,
    });
    expect(place(slotAt('2026-11-25T05:59:00.000Z'), monday, 'UTC')).toMatchObject({
      dayIndex: 1,
      hour: 29,
    });
  });

  it('puts the small hours after Sunday night on Sunday, and the ones after Monday 0:00 on the Sunday before', () => {
    expect(place(slotAt('2026-11-30T02:00:00.000Z'), monday, 'UTC')).toMatchObject({
      dayIndex: 6,
      hour: 26,
    });
    expect(place(slotAt('2026-11-23T02:00:00.000Z'), monday, 'UTC').dayIndex).toBe(-1);
  });

  it('reads the wall clock of the account time zone, not the browser', () => {
    // 14:30 UTC is 23:30 in Tokyo; 16:30 UTC is 1:30 am the next day there, so "25:30".
    expect(place(slotAt('2026-11-24T14:30:00.000Z'), monday, 'Asia/Tokyo')).toMatchObject({
      dayIndex: 1,
      hour: 23,
      minute: 30,
    });
    expect(place(slotAt('2026-11-24T16:30:00.000Z'), monday, 'Asia/Tokyo')).toMatchObject({
      dayIndex: 1,
      hour: 25,
      minute: 30,
    });
  });
});

describe('the week', () => {
  it('finds Monday, this week and either side of it', () => {
    const wednesday = new Date('2026-11-25T12:00:00.000Z');
    expect(mondayOf(wednesday, 'UTC', 0)).toEqual({ y: 2026, m: 11, d: 23 });
    expect(mondayOf(wednesday, 'UTC', 1)).toEqual({ y: 2026, m: 11, d: 30 });
    expect(mondayOf(wednesday, 'UTC', -1)).toEqual({ y: 2026, m: 11, d: 16 });
    // Sunday still belongs to the week that began the Monday before.
    expect(mondayOf(new Date('2026-11-29T23:00:00.000Z'), 'UTC', 0)).toEqual({
      y: 2026,
      m: 11,
      d: 23,
    });
  });

  it('starts a day at local midnight in the zone', () => {
    expect(startOfDay({ y: 2026, m: 11, d: 23 }, 'UTC').toISOString()).toBe(
      '2026-11-23T00:00:00.000Z',
    );
    expect(startOfDay({ y: 2026, m: 11, d: 23 }, 'Asia/Tokyo').toISOString()).toBe(
      '2026-11-22T15:00:00.000Z',
    );
    expect(startOfDay({ y: 2026, m: 11, d: 23 }, 'America/New_York').toISOString()).toBe(
      '2026-11-23T05:00:00.000Z',
    );
  });

  it('falls back to UTC for a zone the browser does not know', () => {
    expect(safeZone('Mars/Olympus')).toBe('UTC');
    expect(safeZone('Asia/Tokyo')).toBe('Asia/Tokyo');
    expect(safeZone(undefined)).toBe('UTC');
  });
});

describe('calendar months', () => {
  it('finds the Monday of any date', () => {
    expect(mondayOfDate({ y: 2026, m: 11, d: 25 })).toEqual({ y: 2026, m: 11, d: 23 });
    expect(mondayOfDate({ y: 2026, m: 11, d: 29 })).toEqual({ y: 2026, m: 11, d: 23 }); // a Sunday
    expect(mondayOfDate({ y: 2026, m: 11, d: 23 })).toEqual({ y: 2026, m: 11, d: 23 });
    expect(mondayOfDate({ y: 2027, m: 1, d: 1 })).toEqual({ y: 2026, m: 12, d: 28 });
  });

  it('lays a month out in whole weeks from the Monday on or before the 1st', () => {
    // November 2026 starts on a Sunday and has 30 days: six weeks.
    expect(monthGrid({ y: 2026, m: 11, d: 14 })).toEqual({
      start: { y: 2026, m: 10, d: 26 },
      weeks: 6,
    });
    // February 2027 starts on a Monday and has 28 days: exactly four weeks.
    expect(monthGrid({ y: 2027, m: 2, d: 1 })).toEqual({
      start: { y: 2027, m: 2, d: 1 },
      weeks: 4,
    });
    // March 2027 starts on a Monday and has 31 days: five weeks.
    expect(monthGrid({ y: 2027, m: 3, d: 9 })).toEqual({
      start: { y: 2027, m: 3, d: 1 },
      weeks: 5,
    });
    // A leap February.
    expect(monthGrid({ y: 2028, m: 2, d: 1 })).toEqual({
      start: { y: 2028, m: 1, d: 31 },
      weeks: 5,
    });
  });

  it('never needs more than six weeks', () => {
    for (let m = 1; m <= 12; m += 1) {
      const { weeks } = monthGrid({ y: 2026, m, d: 1 });
      expect(weeks).toBeGreaterThanOrEqual(4);
      expect(weeks).toBeLessThanOrEqual(6);
    }
  });

  it('moves by months across a year, and counts days between dates', () => {
    expect(addMonths({ y: 2026, m: 11, d: 24 }, 2)).toEqual({ y: 2027, m: 1, d: 1 });
    expect(addMonths({ y: 2026, m: 1, d: 31 }, -1)).toEqual({ y: 2025, m: 12, d: 1 });
    expect(daysBetween({ y: 2026, m: 11, d: 23 }, { y: 2026, m: 12, d: 7 })).toBe(14);
    expect(daysBetween({ y: 2026, m: 12, d: 7 }, { y: 2026, m: 11, d: 23 })).toBe(-14);
  });
});

describe('slot state', () => {
  const now = new Date('2026-11-24T23:42:00.000Z');
  it('is watched once progress reaches the episode, else aired or not yet aired', () => {
    expect(stateOf(slotAt('2026-11-24T22:00:00.000Z'), 8, now)).toBe('seen');
    expect(stateOf(slotAt('2026-11-24T22:00:00.000Z'), 7, now)).toBe('aired');
    expect(stateOf(slotAt('2026-11-25T01:00:00.000Z'), 7, now)).toBe('soon');
  });
});

describe('ticket stock', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  it('uses the cover colour when ink reads on it', () => {
    expect(stockFor({ id, coverColor: '#e4a128' })).toBe('#e4a128');
  });
  it('lightens a cover colour that is too dark until it reads', () => {
    const lightened = stockFor({ id, coverColor: '#1a2a6c' });
    expect(lightened).not.toBe('#1a2a6c');
    expect(lightened).toMatch(/^#[0-9a-f]{6}$/);
  });
  it('falls back to a stock colour, the same one every time, without a usable cover colour', () => {
    expect(stockFor({ id, coverColor: null })).toBe(stockFor({ id }));
    expect(stockFor({ id, coverColor: 'red' })).toBe(stockFor({ id }));
    expect(stockFor({ id, coverColor: '#000000' })).toMatch(/^#[0-9a-f]{6}$/);
  });
});
