import type { ScheduleSlot } from '@akiba/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { describeError } from './errors';

/**
 * The week the way Japanese TV listings draw it (doc 08 §1): an episode that airs between midnight
 * and 6 am belongs to the evening before and is written past 24, so 1:30 am on Wednesday is
 * "25:30" on Tuesday. Everything here works in the viewer's time zone, not the browser's.
 */
export const BROADCAST_CUTOFF_HOUR = 6;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface CalendarDate {
  readonly y: number;
  readonly m: number;
  readonly d: number;
}

/** Wall-clock parts of an instant in a time zone. */
function partsIn(date: Date, zone: string): CalendarDate & { h: number; min: number } {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(date);
  const get = (type: string): number => Number(formatted.find((part) => part.type === type)?.value);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), min: get('minute') };
}

/** A zone name the browser knows, else UTC (the account setting is free text from an old client). */
export function safeZone(zone: string | undefined): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone ?? 'UTC';
  } catch {
    return 'UTC';
  }
}

export function addDays(date: CalendarDate, days: number): CalendarDate {
  const moved = new Date(Date.UTC(date.y, date.m - 1, date.d + days));
  return { y: moved.getUTCFullYear(), m: moved.getUTCMonth() + 1, d: moved.getUTCDate() };
}

const dayNumber = (date: CalendarDate): number => Date.UTC(date.y, date.m - 1, date.d) / DAY_MS;

/** The instant a calendar date begins in `zone` (its local midnight). */
export function startOfDay(date: CalendarDate, zone: string): Date {
  const guess = Date.UTC(date.y, date.m - 1, date.d);
  const seen = partsIn(new Date(guess), zone);
  const shown = Date.UTC(seen.y, seen.m - 1, seen.d, seen.h, seen.min);
  return new Date(guess - (shown - guess));
}

/** Monday of the week that is `offset` weeks from the one containing `now`. */
export function mondayOf(now: Date, zone: string, offset: number): CalendarDate {
  const today = partsIn(now, zone);
  const weekday = new Date(Date.UTC(today.y, today.m - 1, today.d)).getUTCDay(); // 0 = Sunday
  return addDays(today, -((weekday + 6) % 7) + offset * 7);
}

/** The calendar date `now` falls on in `zone`. */
export function todayIn(now: Date, zone: string): CalendarDate {
  const { y, m, d } = partsIn(now, zone);
  return { y, m, d };
}

/** Monday of the week that holds a calendar date. */
export function mondayOfDate(date: CalendarDate): CalendarDate {
  const weekday = new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay(); // 0 = Sunday
  return addDays(date, -((weekday + 6) % 7));
}

/** Whole days from `a` to `b` (negative when b is earlier). */
export const daysBetween = (a: CalendarDate, b: CalendarDate): number =>
  dayNumber(b) - dayNumber(a);

export const sameDate = (a: CalendarDate, b: CalendarDate): boolean =>
  a.y === b.y && a.m === b.m && a.d === b.d;

/** The first of the month `n` months from the one that holds `date`. */
export function addMonths(date: CalendarDate, n: number): CalendarDate {
  const moved = new Date(Date.UTC(date.y, date.m - 1 + n, 1));
  return { y: moved.getUTCFullYear(), m: moved.getUTCMonth() + 1, d: 1 };
}

/**
 * The calendar grid of a month: it starts on the Monday on or before the 1st and runs whole weeks
 * (five or six) to the end of the month.
 */
export function monthGrid(date: CalendarDate): { start: CalendarDate; weeks: number } {
  const first = { y: date.y, m: date.m, d: 1 };
  const start = mondayOfDate(first);
  const inMonth = new Date(Date.UTC(date.y, date.m, 0)).getUTCDate();
  return { start, weeks: Math.ceil((daysBetween(start, first) + inMonth) / 7) };
}

export interface PlacedSlot extends ScheduleSlot {
  /** 0 = Monday … 6 = Sunday, counted from the week's Monday; outside 0 to 6 is another week. */
  readonly dayIndex: number;
  /** The broadcast hour: 24 and up after midnight. */
  readonly hour: number;
  readonly minute: number;
}

export function place(slot: ScheduleSlot, monday: CalendarDate, zone: string): PlacedSlot {
  const at = partsIn(new Date(slot.airsAt), zone);
  const late = at.h < BROADCAST_CUTOFF_HOUR;
  const broadcastDay = late ? addDays(at, -1) : at;
  return {
    ...slot,
    dayIndex: dayNumber(broadcastDay) - dayNumber(monday),
    hour: late ? at.h + 24 : at.h,
    minute: at.min,
  };
}

export const clock = (slot: Pick<PlacedSlot, 'hour' | 'minute'>): string =>
  `${slot.hour}:${String(slot.minute).padStart(2, '0')}`;

export type SlotState = 'seen' | 'aired' | 'soon';

export function stateOf(
  slot: Pick<ScheduleSlot, 'episode' | 'airsAt'>,
  progress: number,
  now: Date,
): SlotState {
  if (progress >= slot.episode) return 'seen';
  return new Date(slot.airsAt).getTime() <= now.getTime() ? 'aired' : 'soon';
}

/** Evening, night, late night: the three rows of the listing. */
export const BANDS = [
  { key: 'evening', jp: '夕', label: 'Evening', range: '17–22', test: (hour: number) => hour < 22 },
  {
    key: 'night',
    jp: '夜',
    label: 'Night',
    range: '22–24',
    test: (hour: number) => hour >= 22 && hour < 24,
  },
  { key: 'late', jp: '深夜', label: 'Late', range: '24–29', test: (hour: number) => hour >= 24 },
] as const;

export const DAY_NAMES = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;

export type WeekLoad =
  | { readonly phase: 'loading' }
  | { readonly phase: 'error'; readonly message: string }
  | { readonly phase: 'ready'; readonly slots: readonly PlacedSlot[] };

/**
 * The schedule of `weeks` whole weeks from the Monday `start` (one for the week view, five or six for
 * a month grid). `dayIndex` of each slot counts from `start`. `setEntryProgress` records an episode
 * logged from the schedule so every slot of that show updates at once without asking the server again.
 */
export function useSchedule(start: CalendarDate, weeks: number) {
  const { client, profile } = useAuth();
  const zone = safeZone(profile?.timeZone);
  const [load, setLoad] = useState<WeekLoad>({ phase: 'loading' });
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [attempt, setAttempt] = useState(0);
  const { y, m, d } = start;
  const monday = useMemo(() => ({ y, m, d }), [y, m, d]);

  useEffect(() => {
    let live = true;
    setLoad({ phase: 'loading' });
    setProgress({});
    // The days asked for, plus the six small hours after the last night (they belong to its evening).
    const from = startOfDay(monday, zone);
    const to = new Date(
      startOfDay(addDays(monday, 7 * weeks), zone).getTime() + BROADCAST_CUTOFF_HOUR * HOUR_MS,
    );
    client.library
      .schedule({ from: from.toISOString(), to: to.toISOString() })
      .then((slots) => {
        if (!live) return;
        const placed = slots
          .map((slot) => place(slot, monday, zone))
          .filter((slot) => slot.dayIndex >= 0 && slot.dayIndex < 7 * weeks);
        setLoad({ phase: 'ready', slots: placed });
      })
      .catch((caught: unknown) => {
        if (live) setLoad({ phase: 'error', message: describeError(caught).message });
      });
    return () => {
      live = false;
    };
  }, [client, monday, weeks, zone, attempt]);

  const progressOf = useCallback(
    (slot: ScheduleSlot): number => progress[slot.entryId] ?? slot.progress,
    [progress],
  );
  const setEntryProgress = useCallback((entryId: string, value: number) => {
    setProgress((current) => ({ ...current, [entryId]: value }));
  }, []);
  const retry = useCallback(() => {
    setAttempt((value) => value + 1);
  }, []);

  return { load, monday, zone, progressOf, setEntryProgress, retry };
}

/** The week that is `offset` weeks from this one (Home's strip uses offset 0). */
export function useWeekSchedule(offset: number) {
  const { profile } = useAuth();
  const zone = safeZone(profile?.timeZone);
  const monday = useMemo(() => mondayOf(new Date(), zone, offset), [zone, offset]);
  return useSchedule(monday, 1);
}
