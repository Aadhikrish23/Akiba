import type { LibraryEntry } from '@akiba/shared';
import { ticketStock } from '@akiba/ui-tokens';
import { useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import { useEntryProgress } from '../lib/progress';
import { ENTRY_LABEL, displayTitle, metaLine } from '../lib/titles';
import { Button, Notice } from './ui';

/**
 * The colour a title's ticket is printed on. Until the catalog supplies each cover's own colour
 * it is one of the stock colours, chosen from the title id so a title always has the same one.
 */
export function stockFor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return ticketStock[hash % ticketStock.length] ?? '#e4a128';
}

type TicketStyle = CSSProperties & { '--stock': string; '--p': number };

/**
 * A show you follow, as a ticket (doc 08 §3): cover, title and numeral on the stub, and a +1 that
 * stamps it. The numeral gets heavier as you get further in. Behaviour (optimistic count, the
 * "Mark completed?" prompt at the last episode) is the shared `useEntryProgress`.
 */
export function Ticket({ entry, size }: { entry: LibraryEntry; size: 'hero' | 'sm' }) {
  const name = displayTitle(entry.title);
  const track = useEntryProgress(entry);
  const total = entry.effectiveTotal;
  const fraction = total === null || total === 0 ? 0.5 : Math.min(1, track.progress / total);
  const [stamp, setStamp] = useState({ count: 0, at: '' });

  const onPlus = () => {
    setStamp((current) => ({
      count: current.count + 1,
      at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    }));
    void track.plusOne();
  };

  const native = entry.title.titleNative;
  const next = track.progress + 1;
  const badge = track.canAdvance
    ? `Next: episode ${next}`
    : track.status === 'completed'
      ? 'Completed'
      : 'Last episode watched';
  const style: TicketStyle = { '--stock': stockFor(entry.title.id), '--p': fraction };

  return (
    <article className="ticket-wrap grid gap-3">
      <div
        className={`ticket ticket--${size}`}
        style={style}
        data-jolt={stamp.count === 0 ? undefined : stamp.count % 2 === 0 ? 'a' : 'b'}
      >
        <div className="ticket__cover">
          {entry.title.coverUrl === null ? (
            <span aria-hidden="true">{name}</span>
          ) : (
            <img src={entry.title.coverUrl} alt="" loading="lazy" decoding="async" />
          )}
        </div>
        <div className="ticket__body">
          <div>
            <p className={`ticket__badge ${track.canAdvance ? '' : 'ticket__badge--quiet'}`}>
              {badge}
            </p>
            <h3 className="ticket__title">
              <Link to={`/title/${entry.title.id}`}>{name}</Link>
            </h3>
            {native !== null && native !== name && (
              <p className="ticket__jp" lang="ja">
                {native}
              </p>
            )}
          </div>
          <div className="grid gap-2">
            <p className="ticket__meta">{metaLine(entry.title)}</p>
            <div
              role="progressbar"
              aria-label={`Progress in ${name}`}
              aria-valuemin={0}
              aria-valuemax={total ?? undefined}
              aria-valuenow={track.progress}
              className="ticket__track"
            >
              <div style={{ width: `${fraction * 100}%` }} />
            </div>
            <p className="ticket__serial" aria-hidden="true">
              NO. {entry.id.slice(0, 6).toUpperCase()} · {ENTRY_LABEL[track.status].toUpperCase()}
            </p>
          </div>
        </div>
        <div className="ticket__stub">
          <p
            className="ticket__num"
            data-testid="episode-count"
            data-pad={track.progress < 10 ? 'true' : undefined}
          >
            {track.progress}
            <span> / {total ?? '?'}</span>
          </p>
          {track.canAdvance ? (
            <button
              type="button"
              className="ticket__plus"
              onClick={onPlus}
              aria-label={`+1 episode of ${name}`}
            >
              +1
            </button>
          ) : (
            <span className="ticket__done" aria-hidden="true" />
          )}
          <div className="ticket__bars" aria-hidden="true" />
        </div>
        <div className="ticket__perf" aria-hidden="true" />
        {stamp.count > 0 && (
          <div className="ticket__stamp" key={stamp.count} aria-hidden="true">
            <div>
              <b>観了</b>
              <span>{stamp.at}</span>
            </div>
          </div>
        )}
      </div>
      {track.error !== null && <Notice tone="error">{track.error}</Notice>}
      {track.suggest && (
        <div role="status" className="flex flex-wrap items-center gap-3 text-sm">
          <span>That was the last episode. Mark completed?</span>
          <Button variant="link" onClick={() => void track.complete()}>
            Yes, mark completed
          </Button>
          <Button variant="link" onClick={track.dismissSuggestion}>
            Not yet
          </Button>
        </div>
      )}
    </article>
  );
}
