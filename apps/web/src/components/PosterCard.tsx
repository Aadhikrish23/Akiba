import type { TitleCard } from '@akiba/shared';
import { Link } from 'react-router';
import { ENTRY_LABEL, displayTitle, metaLine } from '../lib/titles';

/**
 * Poster card (doc 08 §3): 2:3 cover, name and meta below, the whole card one link through the
 * title (stretched link). Where the source has no cover, a typographic placeholder stands in.
 * Library status is words, never colour alone (doc 08 §6).
 */
export function PosterCard({ title }: { title: TitleCard }) {
  const name = displayTitle(title);
  return (
    <article className="has-[:focus-visible]:outline-accent relative grid content-start gap-2 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-4">
      <div className="bg-raised border-rule relative aspect-[2/3] overflow-hidden rounded-sm border">
        {title.coverUrl === null ? (
          <div className="text-mute font-serif grid h-full place-items-center p-3 text-center text-lg">
            {name}
          </div>
        ) : (
          <img
            src={title.coverUrl}
            alt=""
            loading="lazy"
            decoding="async"
            className="size-full object-cover"
          />
        )}
        {title.libraryStatus !== null && (
          <p className="bg-ink text-paper absolute bottom-0 left-0 px-2 py-0.5 text-xs font-medium">
            {ENTRY_LABEL[title.libraryStatus]}
          </p>
        )}
      </div>
      <h3 className="font-serif text-base leading-snug font-semibold">
        <Link
          to={`/title/${title.id}`}
          className="focus-visible:outline-none after:absolute after:inset-0"
        >
          {name}
        </Link>
      </h3>
      <p className="text-mute text-sm">{metaLine(title)}</p>
    </article>
  );
}

/** The grid every list of cards uses: as many 150 px+ columns as fit (doc 08 §7). */
export function PosterGrid({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <ul
      aria-label={label}
      className="grid list-none gap-x-5 gap-y-8 p-0"
      style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}
    >
      {children}
    </ul>
  );
}
