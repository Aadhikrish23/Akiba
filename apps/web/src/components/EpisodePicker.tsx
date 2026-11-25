import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import type { useEntryProgress } from '../lib/progress';

type Tracked = ReturnType<typeof useEntryProgress>;

/** A grid of every episode is only useful for a season, not for a show with a thousand. */
const GRID_MAX = 60;

const FOCUSABLE = 'button:not([disabled]), input:not([disabled])';

function Pencil() {
  return (
    <svg
      className="count-trigger__icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 20h4L19 9l-4-4L4 16z" />
      <path d="m13.5 6.5 4 4" />
    </svg>
  );
}

function Lock() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

/**
 * The picker itself: every episode of the season as a button (the ones that have not aired are
 * locked, so the limit is something you see rather than an error you hit), and a number box for a
 * show too long for a grid. Picking or confirming saves in one request and closes.
 */
function PickerDialog({
  track,
  name,
  onClose,
}: {
  track: Tracked;
  name: string;
  onClose: () => void;
}) {
  const titleId = useId();
  const inputId = useId();
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(String(track.progress));
  const [problem, setProblem] = useState<string | null>(null);

  const gridMax = track.total ?? track.aired;
  const showGrid = gridMax !== null && gridMax <= GRID_MAX;

  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);

  const choose = (value: number) => {
    const issue = track.check(value);
    if (issue !== null) {
      setProblem(issue);
      return;
    }
    if (value !== track.progress) void track.setTo(value);
    onClose();
  };

  const submit = () => {
    if (!/^\d+$/.test(draft.trim())) {
      setProblem('Enter a whole number, 0 or more.');
      return;
    }
    choose(Number(draft));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || box.current === null) return;
    // Keep Tab inside the dialog.
    const items = Array.from(box.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = items[0];
    const last = items[items.length - 1];
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const airedNow = track.aired;
  return createPortal(
    <div
      className="picker-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={box}
        className="picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className="picker__title">
          You are up to episode…
        </h2>
        <p className="picker__name">{name}</p>

        {showGrid && (
          <>
            <ul className="picker__grid" aria-label="Episodes">
              {Array.from({ length: gridMax }, (_, index) => index + 1).map((episode) => {
                const locked = airedNow !== null && episode > airedNow && episode > track.progress;
                const state =
                  episode === track.progress ? 'now' : episode < track.progress ? 'seen' : 'todo';
                return (
                  <li key={episode}>
                    <button
                      type="button"
                      className="picker__ep"
                      data-state={locked ? 'locked' : state}
                      disabled={locked}
                      aria-current={episode === track.progress ? 'true' : undefined}
                      aria-label={
                        locked ? `Episode ${episode}, not aired yet` : `Episode ${episode}`
                      }
                      title={locked ? 'Not aired yet' : undefined}
                      onClick={() => {
                        choose(episode);
                      }}
                    >
                      {locked ? <Lock /> : episode}
                    </button>
                  </li>
                );
              })}
            </ul>
            <p className="picker__legend">
              {airedNow !== null && track.total !== null && airedNow < track.total
                ? `${airedNow} of ${track.total} episodes have aired. The locked ones are still to come.`
                : 'Pick the episode you are up to. Everything before it counts as watched.'}
            </p>
          </>
        )}

        <form
          className="picker__form"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <label htmlFor={inputId}>{showGrid ? 'Or type it' : 'Type the episode'}</label>
          <input
            id={inputId}
            ref={field}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={draft}
            aria-invalid={problem !== null}
            aria-describedby={problem === null ? undefined : `${inputId}-problem`}
            onChange={(event) => {
              const digits = event.target.value.replace(/\D/g, '').slice(0, 6);
              setDraft(digits);
              setProblem(digits === '' ? null : track.check(Number(digits)));
            }}
          />
          <button type="submit" className="picker__go">
            Go
          </button>
          {!showGrid && airedNow !== null && airedNow !== track.progress && (
            <button
              type="button"
              className="picker__latest"
              onClick={() => {
                choose(airedNow);
              }}
            >
              Latest aired · {airedNow}
            </button>
          )}
        </form>
        {problem !== null && (
          <p id={`${inputId}-problem`} role="alert" className="picker__problem">
            {problem}
          </p>
        )}
        <button type="button" className="picker__close" onClick={onClose}>
          Close
        </button>
      </div>
    </div>,
    document.body,
  );
}

/**
 * The episode count on a ticket, row or poster: the number itself, with a dotted underline and a
 * pencil so it reads as something to press. It opens the picker. Once the title is completed the
 * count is plain text.
 */
export function useCountPicker(track: Tracked, name: string): { input: ReactElement } {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  // Focus goes back to the number when the picker closes.
  useEffect(() => {
    if (wasOpen.current && !open) trigger.current?.focus();
    wasOpen.current = open;
  }, [open]);

  if (track.status === 'completed') return { input: <span>{track.progress}</span> };

  const ceiling = track.limit === null ? '' : ` of ${track.limit}`;
  return {
    input: (
      <>
        <button
          ref={trigger}
          type="button"
          className="count-trigger"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`Episode ${track.progress}${ceiling}: change the episode you are up to in ${name}`}
          title="Change the episode you are up to"
          onClick={() => {
            setOpen(true);
          }}
        >
          {track.progress}
          <Pencil />
        </button>
        {open && (
          <PickerDialog
            track={track}
            name={name}
            onClose={() => {
              setOpen(false);
            }}
          />
        )}
      </>
    ),
  };
}
