import type { LibraryEntry } from '@akiba/shared';
import { useRef, useState, type ReactElement } from 'react';
import { Link } from 'react-router';
import { useEntryProgress } from '../lib/progress';
import { ENTRY_LABEL, displayTitle, metaLine } from '../lib/titles';
import { stockFor } from '../lib/stock';
import { Button, Notice } from './ui';

/** A 4 px bar on a track that is visible on its own (doc 08 §6: the track has contrast). */
export function ProgressMeter({
  progress,
  total,
  label,
}: {
  progress: number;
  total: number | null;
  label: string;
}) {
  const percent = total === null || total === 0 ? 0 : Math.min(100, (progress / total) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={total ?? undefined}
      aria-valuenow={progress}
      className="bg-raised-2 h-1.5 w-full overflow-hidden"
    >
      <div className="bg-accent h-full" style={{ width: `${percent}%` }} />
    </div>
  );
}

/** What follows the count: the total, else (a running show) how many have aired, else "?". */
export const countCeiling = (track: { total: number | null; aired: number | null }): string =>
  String(track.total ?? track.aired ?? '?');

type Tracked = ReturnType<typeof useEntryProgress>;

/**
 * The episode count as a field you can click and type in: click the number, type how far you are,
 * and click away or press Enter. Escape puts the old number back. A number the show cannot have
 * (past the total, or past what has aired) is explained and not saved. The caller shows `problem`.
 */
export function useCountEdit(
  track: Tracked,
  name: string,
): { input: ReactElement; problem: string | null } {
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const editable = track.status !== 'completed';
  // Escape blurs the field too, and that blur must not save what was typed.
  const cancelled = useRef(false);

  const finish = () => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    if (draft === null) return;
    const text = draft;
    setDraft(null);
    if (text === '') {
      setProblem(null);
      return;
    }
    const issue = track.check(Number(text));
    setProblem(issue);
    if (issue === null) void track.setTo(Number(text));
  };

  const input = (
    <input
      type="text"
      inputMode="numeric"
      autoComplete="off"
      className="count-input"
      aria-label={`Episodes watched of ${name}`}
      aria-invalid={problem !== null}
      title={editable ? 'Click to change how many episodes you have watched' : undefined}
      readOnly={!editable}
      value={draft ?? String(track.progress)}
      size={Math.max(1, (draft ?? String(track.progress)).length)}
      onFocus={(event) => {
        event.currentTarget.select();
      }}
      onChange={(event) => {
        const digits = event.target.value.replace(/D/g, '').slice(0, 6);
        setDraft(digits);
        setProblem(digits === '' ? null : track.check(Number(digits)));
      }}
      onBlur={finish}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          cancelled.current = true;
          setDraft(null);
          setProblem(null);
          event.currentTarget.blur();
        }
      }}
    />
  );
  return { input, problem };
}

/** `16 / 28` in the display face, tabular figures (doc 08 §8); the first number is editable. */
export function EpisodeCount({ track, input }: { track: Tracked; input: ReactElement }) {
  return (
    <span className="font-display text-2xl font-bold tabular-nums" data-testid="episode-count">
      {input}
      <span className="text-mute"> / {countCeiling(track)}</span>
    </span>
  );
}

function Cover({ entry, size }: { entry: LibraryEntry; size: string }) {
  return entry.title.coverUrl === null ? (
    <div
      className={`bg-raised border-rule ${size} shrink-0 rounded-sm border`}
      aria-hidden="true"
    />
  ) : (
    <img
      src={entry.title.coverUrl}
      alt=""
      loading="lazy"
      className={`${size} shrink-0 rounded-sm object-cover`}
    />
  );
}

/**
 * The "+1 episode" control and its inline follow-ups: error, and "Mark completed?" at the final
 * episode. Used by Home, the library list and the title page, so it behaves the same everywhere.
 */
export function PlusOne({ entry, name }: { entry: LibraryEntry; name: string }) {
  const track = useEntryProgress(entry);
  const edit = useCountEdit(track, name);
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <EpisodeCount track={track} input={edit.input} />
        {track.canAdvance && (
          <Button
            variant="primary"
            onClick={() => void track.plusOne()}
            aria-label={`+1 episode of ${name}`}
          >
            +1 episode
          </Button>
        )}
      </div>
      <ProgressMeter
        progress={track.progress}
        total={entry.effectiveTotal ?? entry.episodesAired}
        label={`Progress in ${name}`}
      />
      {(edit.problem ?? track.error) !== null && (
        <Notice tone="error">{edit.problem ?? track.error}</Notice>
      )}
      {track.suggest && (
        <div
          role="status"
          className="border-rule flex flex-wrap items-center gap-3 border-t pt-2 text-sm"
        >
          <span>That was the last episode. Mark completed?</span>
          <Button variant="link" onClick={() => void track.complete()}>
            Yes, mark completed
          </Button>
          <Button variant="link" onClick={track.dismissSuggestion}>
            Not yet
          </Button>
        </div>
      )}
    </div>
  );
}

/** Home's "Continue watching" card. */
export function ContinueCard({ entry }: { entry: LibraryEntry }) {
  const name = displayTitle(entry.title);
  return (
    <article className="border-rule flex gap-4 border-b py-4">
      <Cover entry={entry} size="h-24 w-16" />
      <div className="grid min-w-0 flex-1 content-start gap-2">
        <h3 className="h-item">
          <Link to={`/title/${entry.title.id}`} className="underline-offset-4 hover:underline">
            {name}
          </Link>
        </h3>
        <PlusOne entry={entry} name={name} />
      </div>
    </article>
  );
}

/** One row of the compact list (doc 08 §3). Fixed slots so rows align when +1 is absent. */
export function LibraryRow({ entry }: { entry: LibraryEntry }) {
  const name = displayTitle(entry.title);
  return (
    <li className="border-rule grid grid-cols-[44px_1fr] items-start gap-x-4 gap-y-2 border-b py-3 min-[880px]:grid-cols-[44px_minmax(0,2fr)_minmax(0,3fr)_5rem]">
      <Cover entry={entry} size="h-16 w-11" />
      <div className="min-w-0">
        <Link to={`/title/${entry.title.id}`} className="h-item underline-offset-4 hover:underline">
          {name}
        </Link>
        <p className="text-mute text-sm">
          {ENTRY_LABEL[entry.status]} · {metaLine(entry.title)}
        </p>
      </div>
      <div className="col-span-2 min-[880px]:col-span-1">
        <PlusOne entry={entry} name={name} />
      </div>
      <p
        className="col-span-2 text-sm tabular-nums min-[880px]:col-span-1 min-[880px]:text-right"
        aria-label={entry.rating === null ? 'Not rated' : `Rated ${entry.rating} out of 10`}
      >
        {entry.rating === null ? '—' : `${entry.rating} / 10`}
      </p>
    </li>
  );
}

/** A poster in the library grid, with progress on the cover's bottom edge. */
export function LibraryPoster({ entry }: { entry: LibraryEntry }) {
  const name = displayTitle(entry.title);
  const stock = stockFor(entry.title);
  return (
    <article
      className="poster has-[:focus-visible]:outline-accent has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-4"
      style={{ '--stock': stock } as React.CSSProperties}
    >
      <div className="poster__cover">
        {entry.title.coverUrl === null ? (
          <div
            className="font-display text-stub-ink grid h-full place-items-center p-3 text-center text-xl leading-none font-extrabold uppercase"
            style={{ background: stock }}
          >
            {name}
          </div>
        ) : (
          <img src={entry.title.coverUrl} alt="" loading="lazy" decoding="async" />
        )}
        <div className="absolute inset-x-0 bottom-0">
          <ProgressMeter
            progress={entry.progress}
            total={entry.effectiveTotal ?? entry.episodesAired}
            label={`Progress in ${name}`}
          />
        </div>
      </div>
      <div className="poster__stub">
        <h3 className="h-item">
          <Link
            to={`/title/${entry.title.id}`}
            className="focus-visible:outline-none after:absolute after:inset-0"
          >
            {name}
          </Link>
        </h3>
        <p className="text-mute text-sm tabular-nums">
          {ENTRY_LABEL[entry.status]} · {entry.progress} /{' '}
          {entry.effectiveTotal ?? entry.episodesAired ?? '?'}
        </p>
      </div>
    </article>
  );
}
