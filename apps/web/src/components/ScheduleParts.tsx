import { useCallback, useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { describeError } from '../lib/errors';
import { DAY_NAMES, clock, stateOf, type PlacedSlot, type SlotState } from '../lib/schedule';
import { stockFor } from '../lib/stock';
import { displayTitle } from '../lib/titles';

const STATE_WORDS: Record<SlotState, string> = {
  seen: 'watched',
  aired: 'aired, not yet watched',
  soon: 'not yet aired',
};

type StockStyle = CSSProperties & { '--stock': string };
const stockStyle = (slot: PlacedSlot): StockStyle => ({ '--stock': stockFor(slot.title) });

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-[1em] fill-none stroke-current"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-5 fill-none stroke-current"
      strokeWidth="1.8"
      strokeLinecap="round"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

/**
 * Logging an episode from the schedule: the count changes at once, the server confirms, and on a
 * failure it goes back and says why (the same contract as the +1 everywhere else).
 */
export function useLogEpisode(
  progressOf: (slot: PlacedSlot) => number,
  setEntryProgress: (entryId: string, value: number) => void,
) {
  const { client } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');

  const log = useCallback(
    async (slot: PlacedSlot) => {
      const before = progressOf(slot);
      setError(null);
      setEntryProgress(slot.entryId, before + 1);
      try {
        const result = await client.library.progress(slot.entryId, { delta: 1 });
        setEntryProgress(slot.entryId, result.data.progress);
        setAnnounce(`${displayTitle(slot.title)}: episode ${result.data.progress} logged.`);
      } catch (caught) {
        setEntryProgress(slot.entryId, before);
        setError(describeError(caught).message);
      }
    },
    [client, progressOf, setEntryProgress],
  );
  return { log, error, announce };
}

interface SlotProps {
  readonly slot: PlacedSlot;
  readonly progress: number;
  readonly now: Date;
  readonly onLog: (slot: PlacedSlot) => void;
}

function slotLabel(slot: PlacedSlot, state: SlotState): string {
  return `${displayTitle(slot.title)}, episode ${slot.episode}, ${DAY_NAMES[((slot.dayIndex % 7) + 7) % 7] ?? ''} ${clock(slot)}${slot.projected ? ' (expected)' : ''}, ${STATE_WORDS[state]}`;
}

function SlotAction({
  slot,
  state,
  onLog,
  progress,
}: {
  slot: PlacedSlot;
  state: SlotState;
  onLog: (slot: PlacedSlot) => void;
  progress: number;
}) {
  if (state === 'aired') {
    return (
      <button
        type="button"
        className="go"
        aria-label={`+1 episode of ${displayTitle(slot.title)}`}
        title={`Logs episode ${progress + 1}`}
        onClick={() => {
          onLog(slot);
        }}
      >
        +1
      </button>
    );
  }
  if (state === 'seen')
    return (
      <span className="ck" aria-hidden="true">
        <CheckIcon />
      </span>
    );
  return <ClockIcon />;
}

/** A slot in the week grid: a small horizontal ticket. */
export function SlotMini({ slot, progress, now, onLog }: SlotProps) {
  const state = stateOf(slot, progress, now);
  const name = displayTitle(slot.title);
  return (
    <div
      className={`mt mt--${state}`}
      style={stockStyle(slot)}
      role="group"
      aria-label={slotLabel(slot, state)}
    >
      <div className="mt__cover" aria-hidden="true">
        {slot.title.coverUrl !== null && <img src={slot.title.coverUrl} alt="" loading="lazy" />}
      </div>
      <div className="mt__body">
        <p className="mt__title">
          <Link to={`/title/${slot.title.id}`}>{name}</Link>
        </p>
        <p className="mt__meta">
          #{slot.episode} · {clock(slot)}
          {slot.projected && <span title="Expected: the weekly slot carried forward"> ~</span>}
        </p>
      </div>
      <div className="mt__act">
        <SlotAction slot={slot} state={state} onLog={onLog} progress={progress} />
      </div>
    </div>
  );
}

/** A slot on Home's week strip: the cover with its status in the corner and the time under it. */
export function SlotThumb({ slot, progress, now, onLog }: SlotProps) {
  const state = stateOf(slot, progress, now);
  return (
    <div
      className={`th th--${state}`}
      style={stockStyle(slot)}
      role="group"
      aria-label={slotLabel(slot, state)}
      title={`${displayTitle(slot.title)} · #${slot.episode}`}
    >
      <Link to={`/title/${slot.title.id}`} tabIndex={-1} aria-hidden="true" className="th__cover">
        {slot.title.coverUrl !== null && <img src={slot.title.coverUrl} alt="" loading="lazy" />}
      </Link>
      <SlotAction slot={slot} state={state} onLog={onLog} progress={progress} />
      <span className="th__time">
        <b>#{slot.episode}</b> {clock(slot)}
        {slot.projected && ' ~'}
      </span>
    </div>
  );
}

/** Tonight on the schedule page: a full ticket whose stub holds the air time. */
export function SlotTonight({ slot, progress, now, onLog }: SlotProps) {
  const state = stateOf(slot, progress, now);
  const name = displayTitle(slot.title);
  const minutes = Math.round((new Date(slot.airsAt).getTime() - now.getTime()) / 60_000);
  const when =
    state === 'soon'
      ? `Airs in ${Math.floor(minutes / 60) > 0 ? `${Math.floor(minutes / 60)}h ` : ''}${minutes % 60}m`
      : state === 'seen'
        ? 'Watched'
        : `Aired ${Math.max(1, Math.round(-minutes / 60))}h ago`;
  return (
    <article className="ticket-wrap">
      <div
        className={`ticket ticket--sm ticket--slot ticket--${state}`}
        style={stockStyle(slot)}
        aria-label={slotLabel(slot, state)}
        role="group"
      >
        <div className="ticket__cover">
          {slot.title.coverUrl !== null && (
            <img src={slot.title.coverUrl} alt="" loading="lazy" decoding="async" />
          )}
        </div>
        <div className="ticket__body">
          <div>
            <p className={`ticket__badge ${state === 'aired' ? '' : 'ticket__badge--quiet'}`}>
              {when}
            </p>
            <h3 className="ticket__title">
              <Link to={`/title/${slot.title.id}`}>{name}</Link>
            </h3>
          </div>
          <p className="ticket__meta">
            Episode {slot.episode}
            {slot.projected ? ' (expected)' : ''}
          </p>
        </div>
        <div className="ticket__stub">
          <p className="ticket__num">{clock(slot)}</p>
          {state === 'aired' ? (
            <button
              type="button"
              className="ticket__plus"
              aria-label={`+1 episode of ${name}`}
              onClick={() => {
                onLog(slot);
              }}
            >
              +1
            </button>
          ) : state === 'seen' ? (
            <span className="ck ticket__done grid place-items-center text-xl" aria-hidden="true">
              <CheckIcon />
            </span>
          ) : (
            <span className="ticket__done grid place-items-center" aria-hidden="true">
              <ClockIcon />
            </span>
          )}
        </div>
        <div className="ticket__perf" aria-hidden="true" />
      </div>
    </article>
  );
}
