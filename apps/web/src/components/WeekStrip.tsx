import { Link } from 'react-router';
import { Notice } from './ui';
import { SlotThumb, useLogEpisode } from './ScheduleParts';
import {
  DAY_NAMES,
  addDays,
  startOfDay,
  todayIn,
  useWeekSchedule,
  type PlacedSlot,
} from '../lib/schedule';

/**
 * Home's "This week": seven days, each with the covers of your shows airing that day. A phone
 * scrolls it sideways; the full timetable is the Schedule screen.
 */
export function WeekStrip() {
  const { load, monday, zone, progressOf, setEntryProgress } = useWeekSchedule(0);
  const { log, error, announce } = useLogEpisode((slot) => progressOf(slot), setEntryProgress);
  const now = new Date();
  const todayIndex = Math.round(
    (startOfDay(todayIn(now, zone), zone).getTime() - startOfDay(monday, zone).getTime()) /
      86_400_000,
  );
  if (load.phase !== 'ready' || load.slots.length === 0) return null;
  const onLog = (slot: PlacedSlot) => void log(slot);

  return (
    <section aria-labelledby="week-strip-heading" className="grid gap-4">
      <h2 id="week-strip-heading" className="h-section flex items-baseline gap-3">
        This week
        <Link
          to="/schedule"
          className="text-mute ml-auto font-sans text-sm font-medium tracking-normal normal-case underline underline-offset-4"
        >
          Full schedule
        </Link>
      </h2>
      <p role="status" className="sr-only">
        {announce}
      </p>
      {error !== null && <Notice tone="error">{error}</Notice>}
      <div
        className="-mx-[var(--gutter)] grid snap-x grid-cols-[repeat(7,124px)] gap-2.5 overflow-x-auto px-[var(--gutter)] pb-2 min-[880px]:mx-0 min-[880px]:grid-cols-7 min-[880px]:overflow-visible min-[880px]:px-0"
        role="group"
        aria-label="Episodes this week"
      >
        {DAY_NAMES.map((name, index) => {
          const slots = load.slots
            .filter((slot) => slot.dayIndex === index)
            .sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));
          const isToday = index === todayIndex;
          return (
            <div key={name} className="grid snap-start content-start gap-2.5">
              <p
                className={`flex items-baseline justify-between border-b-2 px-0.5 pb-1.5 ${
                  isToday ? 'text-ink border-ink' : 'text-mute border-rule'
                }`}
              >
                <span className="text-xs font-bold tracking-widest">
                  {name}
                  {isToday && ' · TODAY'}
                </span>
                <span className="font-display text-2xl leading-none font-extrabold">
                  {addDays(monday, index).d}
                </span>
              </p>
              {slots.length === 0 ? (
                <p className="border-rule text-mute rounded-lg border-[1.5px] border-dashed px-1.5 py-6 text-center text-xs">
                  Nothing on
                </p>
              ) : (
                <div className="grid grid-cols-2 items-start gap-x-2 gap-y-2.5">
                  {slots.map((slot) => (
                    <SlotThumb
                      key={`${slot.entryId}-${slot.episode}`}
                      slot={slot}
                      progress={progressOf(slot)}
                      now={now}
                      onLog={onLog}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
