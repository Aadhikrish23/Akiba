import { useEffect, useRef } from 'react';
import type { WatchChoiceData } from '../lib/services';

const PLAY = (
  <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4 fill-current">
    <path d="M8 5v14l11-7z" />
  </svg>
);

const BUTTON =
  'border-rule hover:border-ink inline-flex min-h-9 items-center gap-1.5 rounded-full border-[1.5px] px-3 text-sm font-bold whitespace-nowrap';

function label(choice: WatchChoiceData): string {
  return choice.exact ? `Watch on ${choice.site}` : `Open ${choice.site}`;
}

/** What the link opens, in words: this episode, or the show's page on that service. */
const kind = (choice: WatchChoiceData): string =>
  choice.exact ? 'Opens this episode' : 'Opens the show page';

/**
 * The Watch control of one episode: nothing when no service of the reader's carries it, a link when
 * one does, and a small menu of links when several do. Links open in a new tab, and say whether they
 * land on the episode or on the show's page.
 */
export function WatchChoice({
  choices,
  className = '',
}: {
  choices: readonly WatchChoiceData[];
  className?: string;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  // The menu closes on a click elsewhere, on Escape, and when a link is chosen, so an open one never
  // sits over the buttons of the next episode.
  useEffect(() => {
    const close = (event: Event) => {
      const element = menu.current;
      if (element === null || !element.open) return;
      if (event instanceof KeyboardEvent) {
        if (event.key !== 'Escape') return;
        element.open = false;
        element.querySelector('summary')?.focus();
      } else if (!element.contains(event.target as Node)) {
        element.open = false;
      }
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, []);
  const [only] = choices;
  if (only === undefined) return null;
  if (choices.length === 1) {
    return (
      <a
        href={only.href}
        target="_blank"
        rel="noopener noreferrer"
        title={kind(only)}
        className={`${BUTTON} ${className}`}
      >
        {PLAY}
        {label(only)}
        {!only.exact && <span className="text-mute font-normal">· show page</span>}
        <span className="sr-only">
          {only.exact ? '' : ' (the show’s page)'}, opens in a new tab
        </span>
      </a>
    );
  }
  return (
    <details ref={menu} className="relative">
      <summary
        className={`${BUTTON} cursor-pointer list-none marker:hidden [&::-webkit-details-marker]:hidden ${className}`}
      >
        {PLAY}
        Watch · {choices.length} services
      </summary>
      <ul className="bg-paper border-rule absolute top-full right-0 z-20 m-0 mt-1.5 grid w-72 list-none gap-0.5 rounded-xl border-[1.5px] p-1.5 shadow-lg">
        {choices.map((choice) => (
          <li key={choice.site}>
            <a
              href={choice.href}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:bg-raised grid gap-0.5 rounded-lg px-3 py-2"
              onClick={() => {
                if (menu.current !== null) menu.current.open = false;
              }}
            >
              <span className="font-bold">{choice.site}</span>
              <span className="text-mute text-xs">
                {kind(choice)}
                <span className="sr-only">, opens in a new tab</span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </details>
  );
}
