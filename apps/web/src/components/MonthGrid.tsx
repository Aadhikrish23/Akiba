import type { CSSProperties } from 'react';
import {
  DAY_NAMES,
  addDays,
  daysBetween,
  sameDate,
  stateOf,
  type CalendarDate,
  type PlacedSlot,
} from '../lib/schedule';
import { stockFor } from '../lib/stock';
import { displayTitle } from '../lib/titles';
import { SlotMini } from './ScheduleParts';

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const CHIPS_PER_DAY = 3;

type StockStyle = CSSProperties & { '--stock': string };

interface MonthGridProps {
  /** The Monday the grid starts on, and how many whole weeks it runs. */
  readonly start: CalendarDate;
  readonly weeks: number;
  /** The month being shown: days outside it are dimmed. */
  readonly month: CalendarDate;
  readonly today: CalendarDate;
  readonly selected: CalendarDate;
  readonly slots: readonly PlacedSlot[];
  readonly progressOf: (slot: PlacedSlot) => number;
  readonly now: Date;
  readonly onSelect: (date: CalendarDate) => void;
}

const byTime = (a: PlacedSlot, b: PlacedSlot): number =>
  a.hour * 60 + a.minute - (b.hour * 60 + b.minute);

/**
 * A month as a calendar: each day holds up to three chips for the shows airing then (a ring when
 * an aired episode is waiting for you), and picking a day shows all of it in the panel beside.
 * Cells are buttons whose label says what is in them; the chips are decoration.
 */
export function MonthGrid(props: MonthGridProps) {
  const { start, weeks, month, today, selected, slots, progressOf, now, onSelect } = props;
  const rows = Array.from({ length: weeks }, (_, week) => week);

  return (
    <table className="mgrid">
      <caption className="sr-only">
        {MONTH_NAMES[month.m - 1]} {month.y}: episodes airing from your list
      </caption>
      <thead>
        <tr>
          {DAY_NAMES.map((name) => (
            <th key={name} scope="col">
              {name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((week) => (
          <tr key={week}>
            {DAY_NAMES.map((name, column) => {
              const date = addDays(start, week * 7 + column);
              const index = daysBetween(start, date);
              const mine = slots.filter((slot) => slot.dayIndex === index).sort(byTime);
              const waiting = mine.some(
                (slot) =>
                  stateOf(slot, progressOf(slot), now) === 'aired' &&
                  slot.entryStatus === 'watching',
              );
              const inMonth = date.m === month.m && date.y === month.y;
              const classes = [
                'mday',
                inMonth ? '' : 'mday--out',
                sameDate(date, today) ? 'mday--today' : '',
              ]
                .filter(Boolean)
                .join(' ');
              const label = `${name} ${date.d} ${MONTH_NAMES[date.m - 1]}, ${
                mine.length === 0
                  ? 'nothing airing'
                  : `${mine.length} episode${mine.length === 1 ? '' : 's'}`
              }${waiting ? ', waiting for a stamp' : ''}`;
              return (
                <td key={name}>
                  <button
                    type="button"
                    className={classes}
                    aria-pressed={sameDate(date, selected)}
                    aria-label={label}
                    onClick={() => {
                      onSelect(date);
                    }}
                  >
                    <span className="mday__num">
                      <span>{date.d}</span>
                      {waiting && <i className="mday__wait" />}
                    </span>
                    <span className="mday__chips" aria-hidden="true">
                      {mine.slice(0, CHIPS_PER_DAY).map((slot) => (
                        <span
                          key={`${slot.entryId}-${slot.episode}`}
                          className={`mchip mchip--${stateOf(slot, progressOf(slot), now)}`}
                          style={{ '--stock': stockFor(slot.title) } as StockStyle}
                        >
                          {slot.title.coverUrl !== null && <img src={slot.title.coverUrl} alt="" />}
                          <em>
                            {displayTitle(slot.title)} #{slot.episode}
                          </em>
                        </span>
                      ))}
                      {mine.length > CHIPS_PER_DAY && (
                        <span className="mday__more">+{mine.length - CHIPS_PER_DAY} more</span>
                      )}
                    </span>
                  </button>
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface DayPanelProps {
  readonly date: CalendarDate;
  readonly today: CalendarDate;
  readonly slots: readonly PlacedSlot[];
  readonly progressOf: (slot: PlacedSlot) => number;
  readonly now: Date;
  readonly onLog: (slot: PlacedSlot) => void;
}

/** The chosen day of the month grid: everything airing then, with +1 on what has aired. */
export function DayPanel({ date, today, slots, progressOf, now, onLog }: DayPanelProps) {
  const mine = [...slots].sort(byTime);
  const waiting = mine.filter(
    (slot) => stateOf(slot, progressOf(slot), now) === 'aired' && slot.entryStatus === 'watching',
  ).length;
  const gap = daysBetween(today, date);
  const when =
    gap === 0
      ? 'Today'
      : gap < 0
        ? `${-gap} day${gap === -1 ? '' : 's'} ago`
        : `In ${gap} day${gap === 1 ? '' : 's'}`;
  const weekday = DAY_NAMES[((daysBetween({ y: 2000, m: 1, d: 3 }, date) % 7) + 7) % 7];
  return (
    <aside className="mpanel" aria-labelledby="day-panel-heading">
      <h3
        id="day-panel-heading"
        className="font-display text-3xl leading-none font-extrabold uppercase"
      >
        {weekday} {date.d} {MONTH_NAMES[date.m - 1]?.slice(0, 3)}
      </h3>
      <p className="text-mute mt-1 mb-4 text-sm">
        {when}
        {mine.length > 0 &&
          ` · ${mine.length} airing${waiting > 0 ? `, ${waiting} waiting for you` : ''}`}
      </p>
      {mine.length === 0 ? (
        <p className="border-rule text-mute rounded-lg border-[1.5px] border-dashed p-6 text-center">
          Nothing from your list airs on this day.
        </p>
      ) : (
        <ul className="m-0 grid list-none gap-3 p-0">
          {mine.map((slot) => (
            <li key={`${slot.entryId}-${slot.episode}`} className="agenda-slot">
              <SlotMini slot={slot} progress={progressOf(slot)} now={now} onLog={onLog} />
            </li>
          ))}
        </ul>
      )}
      {mine.some((slot) => slot.projected) && (
        <p className="text-mute mt-3 text-sm">
          ~ means expected: the weekly slot carried forward, not yet announced.
        </p>
      )}
    </aside>
  );
}
