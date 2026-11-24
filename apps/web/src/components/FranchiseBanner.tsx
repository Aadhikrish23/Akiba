import { mainLineOf, type FranchiseTitle } from '@akiba/shared';
import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { franchiseSummary, type FranchiseInfo } from '../lib/franchise';
import { useRemote } from '../lib/remote';
import { stockFor } from '../lib/stock';
import { ENTRY_LABEL, displayTitle, metaLine } from '../lib/titles';
import { Notice } from './ui';

interface BannerProps {
  readonly franchise: FranchiseInfo;
  /** Covers for the stack on the left (the first three are used). */
  readonly covers: readonly (string | null)[];
  /** After the counts, how you stand ("2 in your library, 1 completed"). */
  readonly standing?: string | undefined;
  /** Shown when the banner is open. */
  readonly children: ReactNode;
}

/**
 * Several seasons of one show under one name (doc 08 §3). Closed it is one ticket-wide row: a stack
 * of covers, the show's name, and how many titles it has and how you stand. Open it lists them.
 * The name is the earliest title's, in the reader's title language, so "My Hero Academia" and not
 * one banner per season.
 */
export function FranchiseBanner({ franchise, covers, standing, children }: BannerProps) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const name = displayTitle(franchise);
  const counts = franchiseSummary(franchise);
  const shown = covers.filter((cover): cover is string => cover !== null).slice(0, 3);
  return (
    <article
      className="border-rule bg-raised rounded-lg border-[1.5px]"
      aria-label={`${name}, ${counts}`}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3 min-[560px]:p-4">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panel}
          onClick={() => {
            setOpen((value) => !value);
          }}
          className="focus-visible:outline-accent flex min-w-0 flex-1 cursor-pointer items-center gap-4 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-4"
        >
          <span className="relative block h-24 w-24 shrink-0" aria-hidden="true">
            {shown.map((cover, index) => (
              <img
                key={cover}
                src={cover}
                alt=""
                loading="lazy"
                className="border-raised absolute top-0 h-24 w-16 rounded-md border-2 object-cover shadow-md"
                style={{
                  left: `${index * 14}px`,
                  transform: `rotate(${(index - 1) * 5}deg)`,
                  zIndex: 3 - index,
                }}
              />
            ))}
          </span>
          <span className="grid min-w-0 gap-1">
            <span className="h-section block leading-none break-words">{name}</span>
            <span className="text-mute text-sm">
              {standing === undefined ? counts : `${counts} · ${standing}`}
            </span>
          </span>
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            className={`text-mute ml-auto size-6 shrink-0 fill-none stroke-current transition-transform ${open ? 'rotate-180' : ''}`}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        <Link
          to={`/franchise/${franchise.id}`}
          className="text-mute min-h-8 text-sm underline underline-offset-4 max-[559px]:hidden"
        >
          Franchise page<span className="sr-only"> of {name}</span>
        </Link>
      </div>
      <div id={panel} hidden={!open} className="border-rule border-t p-3 min-[560px]:p-4">
        {open && children}
      </div>
    </article>
  );
}

/** One title of a franchise: a compact row with its cover, facts and your status in words. */
function TitleRow({ title, season }: { title: FranchiseTitle; season?: number }) {
  const stock = stockFor(title);
  return (
    <li className="border-rule flex items-center gap-3 border-b py-2.5 last:border-b-0">
      {title.coverUrl === null ? (
        <span
          aria-hidden="true"
          className="h-16 w-11 shrink-0 rounded-sm"
          style={{ background: stock }}
        />
      ) : (
        <img
          src={title.coverUrl}
          alt=""
          loading="lazy"
          className="h-16 w-11 shrink-0 rounded-sm object-cover"
        />
      )}
      <div className="min-w-0 flex-1">
        <Link to={`/title/${title.id}`} className="h-item underline-offset-4 hover:underline">
          {displayTitle(title)}
        </Link>
        <p className="text-mute text-sm">
          {season === undefined ? '' : `Season ${season} · `}
          {metaLine(title)}
        </p>
      </div>
      <p className="text-sm font-bold whitespace-nowrap">
        {title.libraryStatus === null ? '' : ENTRY_LABEL[title.libraryStatus]}
      </p>
    </li>
  );
}

/** Everything in a franchise, oldest first, fetched when its banner is opened. */
export function FranchiseTitles({ franchiseId }: { franchiseId: string }) {
  const { client } = useAuth();
  const { state, retry } = useRemote(`franchise-banner:${franchiseId}`, () =>
    client.explore.franchise(franchiseId),
  );
  if (state.phase === 'loading') {
    return (
      <p role="status" aria-busy="true" className="text-mute">
        Loading the seasons…
      </p>
    );
  }
  if (state.phase !== 'ready') {
    return (
      <div className="grid gap-2">
        <Notice tone="error">
          {state.phase === 'missing' ? 'This franchise is no longer available.' : state.message}
        </Notice>
        {state.phase === 'error' && (
          <button type="button" className="w-fit underline underline-offset-4" onClick={retry}>
            Try again
          </button>
        )}
      </div>
    );
  }
  const { titles, totals, relations } = state.value.data;
  // The seasons are the TV titles on the prequel/sequel chain through the first title; everything
  // else (movies, specials, spin-offs) is listed after them.
  const line = mainLineOf(
    titles[0]?.id ?? '',
    relations.map((relation) => ({
      from: relation.fromTitleId,
      to: relation.toTitleId,
      type: relation.relationType,
    })),
  );
  const seasons = titles.filter((title) => line.has(title.id) && title.kind === 'tv');
  const others = titles.filter((title) => !seasons.includes(title));
  return (
    <div className="grid gap-4">
      <p className="text-mute text-sm">
        {totals.inLibrary > 0
          ? `${totals.inLibrary} of ${totals.titles} in your library${
              totals.completed > 0 ? `, ${totals.completed} completed` : ''
            }.`
          : `${totals.titles} titles, oldest first.`}
      </p>
      {seasons.length > 0 && (
        <section aria-label="Seasons">
          <h3 className="text-mute mb-1 text-xs font-bold tracking-widest uppercase">Seasons</h3>
          <ul aria-label="Seasons in this franchise" className="m-0 list-none p-0">
            {seasons.map((title, index) => (
              <TitleRow key={title.id} title={title} season={index + 1} />
            ))}
          </ul>
        </section>
      )}
      {others.length > 0 && (
        <section aria-label="Movies, specials and spin-offs">
          <h3 className="text-mute mb-1 text-xs font-bold tracking-widest uppercase">
            {seasons.length > 0 ? 'Movies, specials and spin-offs' : 'Titles'}
          </h3>
          <ul aria-label="Other titles in this franchise" className="m-0 list-none p-0">
            {others.map((title) => (
              <TitleRow key={title.id} title={title} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
