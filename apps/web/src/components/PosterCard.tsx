import type { TitleCard } from '@akiba/shared';
import { Link } from 'react-router';
import { ENTRY_LABEL, displayTitle, metaLine } from '../lib/titles';
import { stockFor } from '../lib/stock';

/**
 * Poster ticket (doc 08 §3): a 2:3 cover with a perforated stub under it, name and meta on the
 * stub, the whole card one link through the title (stretched link). Where the source has no cover,
 * a typographic placeholder on the title's stock colour stands in. Library status is words, never
 * colour alone (doc 08 §6).
 */
export function PosterCard({ title }: { title: TitleCard }) {
  const name = displayTitle(title);
  const stock = stockFor(title);
  return (
    <article
      className="poster has-[:focus-visible]:outline-accent has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-4"
      style={{ '--stock': stock } as React.CSSProperties}
    >
      <div className="poster__cover">
        {title.coverUrl === null ? (
          <div
            className="font-display text-stub-ink grid h-full place-items-center p-3 text-center text-xl leading-none font-extrabold uppercase"
            style={{ background: stock }}
          >
            {name}
          </div>
        ) : (
          <img src={title.coverUrl} alt="" loading="lazy" decoding="async" />
        )}
        {title.libraryStatus !== null && (
          <p className="poster__tag">{ENTRY_LABEL[title.libraryStatus]}</p>
        )}
      </div>
      <div className="poster__stub">
        <h3 className="h-item">
          <Link
            to={`/title/${title.id}`}
            className="focus-visible:outline-none after:absolute after:inset-0"
          >
            {name}
          </Link>
        </h3>
        <p className="text-mute text-sm leading-snug">{metaLine(title)}</p>
      </div>
    </article>
  );
}

/** The grid every list of cards uses: as many 160 px+ columns as fit (doc 08 §7). */
export function PosterGrid({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <ul
      aria-label={label}
      className="grid list-none gap-x-5 gap-y-8 p-0"
      style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 160px), 1fr))' }}
    >
      {children}
    </ul>
  );
}
