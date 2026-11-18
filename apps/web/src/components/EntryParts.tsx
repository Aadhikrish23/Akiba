import type { LibraryEntry } from '@akiba/shared';
import { Link } from 'react-router';
import { useEntryProgress } from '../lib/progress';
import { ENTRY_LABEL, displayTitle, metaLine } from '../lib/titles';
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
      className="bg-rule h-1 w-full overflow-hidden rounded-sm"
    >
      <div className="bg-accent h-full" style={{ width: `${percent}%` }} />
    </div>
  );
}

/** `16 / 28` in a serif, tabular figures (doc 08 §8). */
export function EpisodeCount({ progress, total }: { progress: number; total: number | null }) {
  return (
    <span className="font-serif text-xl tabular-nums" data-testid="episode-count">
      {progress}
      <span className="text-mute"> / {total ?? '?'}</span>
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
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <EpisodeCount progress={track.progress} total={entry.effectiveTotal} />
        {track.canAdvance && (
          <Button
            onClick={() => void track.plusOne()}
            busy={track.busy}
            aria-label={`Log one episode of ${name}`}
          >
            +1 episode
          </Button>
        )}
      </div>
      <ProgressMeter
        progress={track.progress}
        total={entry.effectiveTotal}
        label={`Progress in ${name}`}
      />
      {track.error !== null && <Notice tone="error">{track.error}</Notice>}
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
        <h3 className="font-serif text-base font-semibold">
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
        <Link
          to={`/title/${entry.title.id}`}
          className="font-serif font-semibold underline-offset-4 hover:underline"
        >
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
  return (
    <article className="has-[:focus-visible]:outline-accent relative grid content-start gap-2 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-4">
      <div className="bg-raised border-rule relative aspect-[2/3] overflow-hidden rounded-sm border">
        {entry.title.coverUrl === null ? (
          <div className="text-mute font-serif grid h-full place-items-center p-3 text-center text-lg">
            {name}
          </div>
        ) : (
          <img
            src={entry.title.coverUrl}
            alt=""
            loading="lazy"
            className="size-full object-cover"
          />
        )}
        <div className="absolute inset-x-0 bottom-0">
          <ProgressMeter
            progress={entry.progress}
            total={entry.effectiveTotal}
            label={`Progress in ${name}`}
          />
        </div>
      </div>
      <h3 className="font-serif text-base leading-snug font-semibold">
        <Link
          to={`/title/${entry.title.id}`}
          className="focus-visible:outline-none after:absolute after:inset-0"
        >
          {name}
        </Link>
      </h3>
      <p className="text-mute text-sm tabular-nums">
        {ENTRY_LABEL[entry.status]} · {entry.progress} / {entry.effectiveTotal ?? '?'}
      </p>
    </article>
  );
}
