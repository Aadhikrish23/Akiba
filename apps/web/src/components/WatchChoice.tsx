import type { WatchChoiceData } from '../lib/services';

const PLAY = (
  <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4 fill-current">
    <path d="M8 5v14l11-7z" />
  </svg>
);

/**
 * The Watch button of one episode: a link that opens that episode on the service that has it, in a
 * new tab. Nothing at all when there is no such link, so a button never leads somewhere else.
 */
export function WatchChoice({
  choices,
  className = '',
}: {
  choices: readonly WatchChoiceData[];
  className?: string;
}) {
  const [choice] = choices;
  if (choice === undefined) return null;
  return (
    <a
      href={choice.href}
      target="_blank"
      rel="noopener noreferrer"
      title="Opens this episode"
      className={`border-rule hover:border-ink inline-flex min-h-9 items-center gap-1.5 rounded-full border-[1.5px] px-3 text-sm font-bold whitespace-nowrap ${className}`}
    >
      {PLAY}
      Watch on {choice.site}
      <span className="sr-only"> (this episode), opens in a new tab</span>
    </a>
  );
}
