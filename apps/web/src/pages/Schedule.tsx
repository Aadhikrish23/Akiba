import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { DayPanel, MONTH_NAMES, MonthGrid } from '../components/MonthGrid';
import { SlotMini, SlotTonight, useLogEpisode } from '../components/ScheduleParts';
import { Button, Notice } from '../components/ui';
import { usePageTitle } from '../lib/page';
import {
  BANDS,
  DAY_NAMES,
  addDays,
  addMonths,
  daysBetween,
  monthGrid,
  mondayOfDate,
  safeZone,
  sameDate,
  stateOf,
  todayIn,
  useSchedule,
  type CalendarDate,
  type PlacedSlot,
} from '../lib/schedule';

type Mode = 'week' | 'month';
const MODE_KEY = 'akiba.schedule.mode';
const MONTHS_SHORT = MONTH_NAMES.map((name) => name.slice(0, 3));

function readMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === 'month' ? 'month' : 'week';
  } catch {
    return 'week';
  }
}

const selectClass =
  'border-rule bg-raised text-ink h-11 min-w-0 flex-1 rounded-md border px-3 text-base min-[880px]:flex-none';

function Chevron({ direction }: { direction: 'left' | 'right' }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-5 fill-none stroke-current"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={direction === 'left' ? 'm15 5-7 7 7 7' : 'm9 5 7 7-7 7'} />
    </svg>
  );
}

/**
 * Your schedule, on air (doc 08 §1): tonight as tickets, and your shows as a timetable of a week in
 * broadcast time (25:30 is 1:30 am the next morning) or a calendar of a month. Step through as many
 * weeks or months as you like, or jump to one. On a phone the week grid becomes a day agenda.
 */
export function SchedulePage() {
  usePageTitle('Schedule');
  const { profile } = useAuth();
  const zone = safeZone(profile?.timeZone);
  const now = new Date();
  const today = todayIn(now, zone);

  const [mode, setModeState] = useState<Mode>(readMode);
  // The day the view is around; null means today.
  const [focus, setFocus] = useState<CalendarDate | null>(null);
  const [picked, setPicked] = useState<CalendarDate | null>(null);
  const anchor = focus ?? today;

  const week = { start: mondayOfDate(anchor), weeks: 1 };
  const month = monthGrid(anchor);
  const range = mode === 'week' ? week : month;
  const { load, monday, progressOf, setEntryProgress, retry } = useSchedule(
    range.start,
    range.weeks,
  );
  const { log, error, announce } = useLogEpisode((slot) => progressOf(slot), setEntryProgress);
  const onLog = (slot: PlacedSlot) => void log(slot);

  const setMode = (next: Mode) => {
    setModeState(next);
    setPicked(null);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      // The choice just is not remembered.
    }
  };
  const goTo = (date: CalendarDate | null) => {
    setFocus(date);
    setPicked(null);
  };
  const step = (direction: 1 | -1) => {
    goTo(mode === 'week' ? addDays(anchor, 7 * direction) : addMonths(anchor, direction));
  };

  const unit = mode;
  const onThisPeriod =
    mode === 'week'
      ? sameDate(week.start, mondayOfDate(today))
      : anchor.y === today.y && anchor.m === today.m;

  // Keys: ← → step, T today, W week, M month (never while typing or choosing in a field).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.closest('input, select, textarea') ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      )
        return;
      if (event.key === 'ArrowLeft') step(-1);
      else if (event.key === 'ArrowRight') step(1);
      else if (event.key === 't' || event.key === 'T') goTo(null);
      else if (event.key === 'w' || event.key === 'W') setMode('week');
      else if (event.key === 'm' || event.key === 'M') setMode('month');
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  });

  const slots: readonly PlacedSlot[] = load.phase === 'ready' ? load.slots : [];

  // The day shown in the month panel and in the phone's week agenda.
  const within = (date: CalendarDate | null): date is CalendarDate =>
    date !== null &&
    daysBetween(monday, date) >= 0 &&
    daysBetween(monday, date) < 7 * range.weeks &&
    (mode === 'week' || (date.m === anchor.m && date.y === anchor.y));
  const first = mode === 'week' ? week.start : { y: anchor.y, m: anchor.m, d: 1 };
  const selected: CalendarDate = within(picked) ? picked : within(today) ? today : first;
  const selectedIndex = daysBetween(monday, selected);

  const sunday = addDays(week.start, 6);
  const label =
    mode === 'month'
      ? `${MONTH_NAMES[anchor.m - 1]} ${anchor.y}`
      : `${MONTHS_SHORT[week.start.m - 1]} ${week.start.d} – ${
          week.start.m === sunday.m ? '' : `${MONTHS_SHORT[sunday.m - 1]} `
        }${sunday.d}${week.start.y === sunday.y && week.start.y === today.y ? '' : `, ${sunday.y}`}`;

  const waiting = slots.filter(
    (slot) =>
      new Date(slot.airsAt) <= now &&
      progressOf(slot) < slot.episode &&
      slot.entryStatus === 'watching',
  ).length;
  const count = (state: 'seen' | 'soon') =>
    slots.filter((slot) => stateOf(slot, progressOf(slot), now) === state).length;
  const period = `${onThisPeriod ? 'this' : 'in this'} ${unit}`;

  const todayIndex = daysBetween(week.start, today);
  const tonight =
    mode === 'week' && onThisPeriod ? slots.filter((s) => s.dayIndex === todayIndex) : [];
  const slotsFor = (day: number, test?: (hour: number) => boolean) =>
    slots
      .filter((slot) => slot.dayIndex === day && (test === undefined || test(slot.hour)))
      .sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));

  const thisYear = today.y;
  const years = Array.from({ length: 7 }, (_, i) => thisYear - 3 + i);
  if (!years.includes(anchor.y)) years.push(anchor.y);
  years.sort((a, b) => a - b);

  return (
    <div className="grid gap-8">
      <div className="grid gap-3">
        <h1 className="h-page">
          Your week, <em>on air.</em>
        </h1>
        {load.phase === 'ready' && (
          <p className="text-mute max-w-[58ch] text-lg">
            {slots.length === 0
              ? `Nothing from your list airs ${period}.`
              : waiting === 0
                ? onThisPeriod
                  ? `Everything that has aired ${period} is stamped.`
                  : `Nothing is waiting for a stamp ${period}.`
                : `${waiting} ${waiting === 1 ? 'episode has' : 'episodes have'} aired and ${waiting === 1 ? 'is' : 'are'} waiting for a stamp.`}
          </p>
        )}
      </div>

      <p role="status" className="sr-only">
        {announce}
      </p>
      {error !== null && <Notice tone="error">{error}</Notice>}

      {tonight.length > 0 && (
        <section aria-labelledby="tonight-heading" className="grid gap-4">
          <h2 id="tonight-heading" className="h-section">
            Tonight
          </h2>
          <div
            className="grid gap-x-6 gap-y-8"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 340px), 1fr))' }}
          >
            {tonight.map((slot) => (
              <SlotTonight
                key={`${slot.entryId}-${slot.episode}`}
                slot={slot}
                progress={progressOf(slot)}
                now={now}
                onLog={onLog}
              />
            ))}
          </div>
        </section>
      )}

      <section aria-labelledby="week-heading" className="grid gap-4">
        <h2 id="week-heading" className="h-section flex flex-wrap items-baseline gap-x-4">
          {mode === 'week' ? 'The week' : 'The month'}
          <small className="text-mute font-sans text-sm font-normal tracking-normal normal-case">
            Times are broadcast time: 25:00 is 1 am the next morning.
          </small>
        </h2>

        <div className="flex flex-wrap items-center gap-3">
          <div
            role="radiogroup"
            aria-label="View"
            className="border-rule bg-raised grid auto-cols-fr grid-flow-col rounded-full border-[1.5px] p-[3px] max-[879px]:w-full"
          >
            {(['week', 'month'] as const).map((value) => (
              <label key={value} className="relative cursor-pointer">
                <input
                  type="radio"
                  name="schedule-view"
                  value={value}
                  checked={mode === value}
                  onChange={() => {
                    setMode(value);
                  }}
                  className="peer absolute inset-0 cursor-pointer opacity-0"
                />
                <span className="text-mute peer-checked:bg-ink peer-checked:text-paper peer-focus-visible:outline-accent block rounded-full px-5 py-2 text-center text-sm font-bold capitalize peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2">
                  {value}
                </span>
              </label>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              aria-label={`Previous ${unit}`}
              className="!w-11 !px-0"
              onClick={() => {
                step(-1);
              }}
            >
              <Chevron direction="left" />
            </Button>
            <p
              aria-live="polite"
              className="font-display min-w-44 text-center text-3xl font-extrabold uppercase"
            >
              {label}
            </p>
            <Button
              aria-label={`Next ${unit}`}
              className="!w-11 !px-0"
              onClick={() => {
                step(1);
              }}
            >
              <Chevron direction="right" />
            </Button>
            {!onThisPeriod && (
              <Button
                onClick={() => {
                  goTo(null);
                }}
              >
                This {unit}
              </Button>
            )}
          </div>

          <div className="text-mute flex items-center gap-2 text-sm max-[879px]:w-full min-[880px]:ml-auto">
            <span aria-hidden="true">Jump to</span>
            <select
              aria-label="Month"
              className={selectClass}
              value={anchor.m}
              onChange={(event) => {
                goTo({ y: anchor.y, m: Number(event.target.value), d: 1 });
              }}
            >
              {MONTH_NAMES.map((name, index) => (
                <option key={name} value={index + 1}>
                  {name}
                </option>
              ))}
            </select>
            <select
              aria-label="Year"
              className={selectClass}
              value={anchor.y}
              onChange={(event) => {
                goTo({ y: Number(event.target.value), m: anchor.m, d: 1 });
              }}
            >
              {years.map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          {load.phase === 'ready' && slots.length > 0 && (
            <ul className="m-0 flex list-none flex-wrap gap-2 p-0 text-sm" aria-label="This view">
              <li className="border-rule bg-raised rounded-full border-[1.5px] px-3.5 py-1.5">
                <b className="font-display text-accent mr-1 text-lg font-extrabold">{waiting}</b>
                waiting for a stamp
              </li>
              <li className="border-rule bg-raised text-mute rounded-full border-[1.5px] px-3.5 py-1.5">
                <b className="font-display text-ink mr-1 text-lg font-extrabold">{count('seen')}</b>
                watched
              </li>
              <li className="border-rule bg-raised text-mute rounded-full border-[1.5px] px-3.5 py-1.5">
                <b className="font-display text-ink mr-1 text-lg font-extrabold">{count('soon')}</b>
                still to air
              </li>
            </ul>
          )}
          <p
            className="text-mute flex flex-wrap gap-x-5 text-sm min-[880px]:ml-auto"
            aria-label="Legend"
          >
            <span>Ringed: aired, waiting for you</span>
            <span>Muted: watched</span>
            <span>Dashed: not yet aired</span>
          </p>
        </div>
        <p className="text-mute text-sm max-[879px]:hidden">
          Keys: ← → to step, T for today, W for week, M for month.
        </p>

        {load.phase === 'loading' && (
          <p role="status" aria-busy="true" className="text-mute">
            Loading your {unit}…
          </p>
        )}
        {load.phase === 'error' && (
          <div className="grid max-w-prose gap-3">
            <Notice tone="error">{load.message}</Notice>
            <div>
              <Button onClick={retry}>Try again</Button>
            </div>
          </div>
        )}
        {load.phase === 'ready' && slots.length === 0 && (
          <p className="text-mute max-w-prose">
            Nothing from your list airs {period}. Titles you are Watching or have Planned appear
            here once their air times are known.{' '}
            <Link to="/discover" className="underline underline-offset-4">
              Find something to watch
            </Link>
            .
          </p>
        )}

        {load.phase === 'ready' && mode === 'month' && (
          <div className="grid items-start gap-6 min-[1181px]:grid-cols-[minmax(0,1fr)_340px]">
            <MonthGrid
              start={monday}
              weeks={month.weeks}
              month={{ y: anchor.y, m: anchor.m, d: 1 }}
              today={today}
              selected={selected}
              slots={slots}
              progressOf={progressOf}
              now={now}
              onSelect={(date) => {
                // A day of the neighbouring month opens that month.
                if (date.m !== anchor.m || date.y !== anchor.y)
                  setFocus({ y: date.y, m: date.m, d: 1 });
                setPicked(date);
              }}
            />
            <DayPanel
              date={selected}
              today={today}
              slots={slots.filter((slot) => slot.dayIndex === selectedIndex)}
              progressOf={progressOf}
              now={now}
              onLog={onLog}
            />
          </div>
        )}

        {load.phase === 'ready' && mode === 'week' && slots.length > 0 && (
          <>
            {/* Wide screens: the timetable. */}
            <table className="border-rule hidden w-full table-fixed border-separate border-spacing-0 overflow-hidden rounded-lg border min-[880px]:table">
              <caption className="sr-only">
                Weekly airing schedule for the shows on your list, in broadcast time
              </caption>
              <thead>
                <tr>
                  <th scope="col" className="bg-raised border-rule w-24 border-r border-b">
                    <span className="sr-only">Time of night</span>
                  </th>
                  {DAY_NAMES.map((name, index) => {
                    const date = addDays(monday, index);
                    const isToday = sameDate(date, today);
                    return (
                      <th
                        key={name}
                        scope="col"
                        className={`border-rule border-r border-b px-3 pt-3 pb-2 text-left font-normal last:border-r-0 ${
                          isToday ? 'bg-ink text-paper' : 'bg-raised'
                        }`}
                      >
                        <span
                          className={`block text-xs font-bold tracking-widest ${isToday ? '' : 'text-mute'}`}
                        >
                          {name}
                          {isToday && ' · TODAY'}
                        </span>
                        <span className="font-display block text-4xl leading-none font-extrabold">
                          {date.d}
                        </span>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {BANDS.map((band) => (
                  <tr key={band.key}>
                    <th
                      scope="row"
                      className="bg-raised border-rule text-mute border-r border-b p-3 text-left align-top font-normal last:border-b-0"
                    >
                      <b className="text-ink block text-3xl leading-none">{band.jp}</b>
                      <span className="mt-1.5 block text-xs font-bold tracking-widest uppercase">
                        {band.label}
                      </span>
                      <small className="text-xs">{band.range}</small>
                    </th>
                    {DAY_NAMES.map((name, index) => {
                      const cell = slotsFor(index, band.test);
                      const isToday = sameDate(addDays(monday, index), today);
                      return (
                        <td
                          key={name}
                          className={`border-rule h-28 border-r border-b p-2 align-top last:border-r-0 ${
                            isToday ? 'bg-raised' : ''
                          }`}
                        >
                          <ul className="m-0 grid list-none gap-2 p-0">
                            {cell.map((slot) => (
                              <li
                                key={`${slot.entryId}-${slot.episode}`}
                                style={
                                  {
                                    '--cell': isToday ? 'var(--raised)' : 'var(--paper)',
                                  } as React.CSSProperties
                                }
                              >
                                <SlotMini
                                  slot={slot}
                                  progress={progressOf(slot)}
                                  now={now}
                                  onLog={onLog}
                                />
                              </li>
                            ))}
                          </ul>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Phones: a day at a time. */}
            <div className="grid gap-4 min-[880px]:hidden">
              <div role="tablist" aria-label="Day of the week" className="grid grid-cols-7 gap-1">
                {DAY_NAMES.map((name, index) => {
                  const dayCount = slotsFor(index).length;
                  const active = selectedIndex === index;
                  return (
                    <button
                      key={name}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => {
                        setPicked(addDays(monday, index));
                      }}
                      className={`border-rule grid min-h-16 cursor-pointer content-center justify-items-center gap-0.5 rounded-lg border-[1.5px] ${
                        active ? 'bg-ink text-paper border-ink' : 'bg-raised'
                      }`}
                    >
                      <span
                        className={`text-[0.6875rem] font-bold tracking-wider ${active ? '' : 'text-mute'}`}
                      >
                        {name}
                      </span>
                      <b className="font-display text-xl leading-none font-extrabold">
                        {addDays(monday, index).d}
                      </b>
                      <small className="min-h-3 text-[0.6875rem] font-bold">
                        {dayCount > 0 ? dayCount : ''}
                        <span className="sr-only">
                          {dayCount > 0 ? ' airing' : ' (none airing)'}
                        </span>
                      </small>
                    </button>
                  );
                })}
              </div>
              {slotsFor(selectedIndex).length === 0 ? (
                <p className="border-rule text-mute rounded-lg border-[1.5px] border-dashed p-8 text-center">
                  Nothing from your list airs on {DAY_NAMES[selectedIndex]}.
                </p>
              ) : (
                <ul className="m-0 grid list-none gap-4 p-0">
                  {slotsFor(selectedIndex).map((slot) => (
                    <li key={`${slot.entryId}-${slot.episode}`} className="agenda-slot">
                      <SlotMini slot={slot} progress={progressOf(slot)} now={now} onLog={onLog} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
