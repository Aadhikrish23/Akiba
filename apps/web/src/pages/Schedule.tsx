import { useState } from 'react';
import { Link } from 'react-router';
import { Button, Notice } from '../components/ui';
import { SlotMini, SlotTonight, useLogEpisode } from '../components/ScheduleParts';
import { usePageTitle } from '../lib/page';
import {
  BANDS,
  DAY_NAMES,
  addDays,
  startOfDay,
  todayIn,
  useWeekSchedule,
  type PlacedSlot,
} from '../lib/schedule';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Your week, on air (doc 08 §1): tonight as tickets, and the week as a timetable of your own shows
 * in broadcast time (25:30 is 1:30 am the next morning). On a phone the grid becomes a day agenda.
 */
export function SchedulePage() {
  usePageTitle('Schedule');
  const [offset, setOffset] = useState(0);
  const { load, monday, zone, progressOf, setEntryProgress, retry } = useWeekSchedule(offset);
  const { log, error, announce } = useLogEpisode((slot) => progressOf(slot), setEntryProgress);
  const now = new Date();
  const today = todayIn(now, zone);
  const todayIndex =
    Math.round(
      (startOfDay(today, zone).getTime() - startOfDay(monday, zone).getTime()) / 86_400_000,
    ) || 0;
  const thisWeek = offset === 0;
  const [pickedDay, setPickedDay] = useState<number | null>(null);
  const agendaDay = pickedDay ?? (thisWeek && todayIndex >= 0 && todayIndex <= 6 ? todayIndex : 0);

  const slots: readonly PlacedSlot[] = load.phase === 'ready' ? load.slots : [];
  const sunday = addDays(monday, 6);
  const range = `${MONTHS[monday.m - 1]} ${monday.d} – ${
    monday.m === sunday.m ? '' : `${MONTHS[sunday.m - 1]} `
  }${sunday.d}`;
  const onLog = (slot: PlacedSlot) => void log(slot);

  const tonight = thisWeek ? slots.filter((slot) => slot.dayIndex === todayIndex) : [];
  const waiting = slots.filter(
    (slot) =>
      new Date(slot.airsAt) <= now &&
      progressOf(slot) < slot.episode &&
      slot.entryStatus === 'watching',
  ).length;

  const slotsFor = (day: number, test?: (hour: number) => boolean) =>
    slots
      .filter((slot) => slot.dayIndex === day && (test === undefined || test(slot.hour)))
      .sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));

  return (
    <div className="grid gap-8">
      <div className="grid gap-3">
        <h1 className="h-page">
          Your week, <em>on air.</em>
        </h1>
        {load.phase === 'ready' && (
          <p className="text-mute max-w-[58ch] text-lg">
            {slots.length === 0
              ? 'Nothing from your list airs this week.'
              : waiting === 0
                ? 'Everything that has aired this week is stamped.'
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
          The week
          <small className="text-mute font-sans text-sm font-normal tracking-normal normal-case">
            Times are broadcast time: 25:00 is 1 am the next morning.
          </small>
        </h2>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            aria-label="Previous week"
            disabled={offset <= -1}
            className="!w-11 !px-0"
            onClick={() => {
              setOffset((value) => value - 1);
              setPickedDay(null);
            }}
          >
            <svg
              viewBox="0 0 24 24"
              aria-hidden="true"
              className="size-5 fill-none stroke-current"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m15 5-7 7 7 7" />
            </svg>
          </Button>
          <p
            aria-live="polite"
            className="font-display min-w-44 text-center text-3xl font-extrabold uppercase"
          >
            {range}
          </p>
          <Button
            aria-label="Next week"
            disabled={offset >= 1}
            className="!w-11 !px-0"
            onClick={() => {
              setOffset((value) => value + 1);
              setPickedDay(null);
            }}
          >
            <svg
              viewBox="0 0 24 24"
              aria-hidden="true"
              className="size-5 fill-none stroke-current"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m9 5 7 7-7 7" />
            </svg>
          </Button>
          {!thisWeek && (
            <Button
              onClick={() => {
                setOffset(0);
                setPickedDay(null);
              }}
            >
              This week
            </Button>
          )}
          <p className="text-mute ml-auto flex flex-wrap gap-x-5 text-sm" aria-label="Legend">
            <span>Ringed: aired, waiting for you</span>
            <span>Muted: watched</span>
            <span>Dashed: not yet aired</span>
          </p>
        </div>

        {load.phase === 'loading' && (
          <p role="status" aria-busy="true" className="text-mute">
            Loading your week…
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
            Nothing from your list airs this week. Titles you are Watching or have Planned appear
            here once their air times are known.{' '}
            <Link to="/discover" className="underline underline-offset-4">
              Find something to watch
            </Link>
            .
          </p>
        )}

        {load.phase === 'ready' && slots.length > 0 && (
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
                    const isToday = thisWeek && index === todayIndex;
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
                      return (
                        <td
                          key={name}
                          className={`border-rule h-28 border-r border-b p-2 align-top last:border-r-0 ${
                            thisWeek && index === todayIndex ? 'bg-raised' : ''
                          }`}
                        >
                          <ul className="m-0 grid list-none gap-2 p-0">
                            {cell.map((slot) => (
                              <li
                                key={`${slot.entryId}-${slot.episode}`}
                                style={
                                  {
                                    '--cell':
                                      thisWeek && index === todayIndex
                                        ? 'var(--raised)'
                                        : 'var(--paper)',
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
                  const count = slotsFor(index).length;
                  return (
                    <button
                      key={name}
                      type="button"
                      role="tab"
                      aria-selected={agendaDay === index}
                      aria-label={`${name} ${addDays(monday, index).d}, ${count} airing`}
                      onClick={() => {
                        setPickedDay(index);
                      }}
                      className={`border-rule grid min-h-16 cursor-pointer content-center justify-items-center gap-0.5 rounded-lg border-[1.5px] ${
                        agendaDay === index ? 'bg-ink text-paper border-ink' : 'bg-raised'
                      }`}
                    >
                      <span
                        className={`text-[0.6875rem] font-bold tracking-wider ${agendaDay === index ? '' : 'text-mute'}`}
                      >
                        {name}
                      </span>
                      <b className="font-display text-xl leading-none font-extrabold">
                        {addDays(monday, index).d}
                      </b>
                      <small className="min-h-3 text-[0.6875rem] font-bold">
                        {count > 0 ? count : ''}
                      </small>
                    </button>
                  );
                })}
              </div>
              {slotsFor(agendaDay).length === 0 ? (
                <p className="border-rule text-mute rounded-lg border-[1.5px] border-dashed p-8 text-center">
                  Nothing from your list airs on {DAY_NAMES[agendaDay]}.
                </p>
              ) : (
                <ul className="m-0 grid list-none gap-4 p-0">
                  {slotsFor(agendaDay).map((slot) => (
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
