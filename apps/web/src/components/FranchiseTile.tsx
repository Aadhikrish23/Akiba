import type { CSSProperties } from 'react';
import { Link } from 'react-router';
import { franchiseSummary, type FranchiseInfo } from '../lib/franchise';
import { stockFor } from '../lib/stock';
import { displayTitle } from '../lib/titles';

interface TileProps {
  readonly franchise: FranchiseInfo;
  /** Covers for the stack (the first three are used) and a colour to print the placeholder on. */
  readonly covers: readonly { readonly id: string; readonly coverUrl: string | null }[];
  /** After the counts: how you stand ("2 in your library, 1 completed"). */
  readonly standing?: string | undefined;
  /** A segment per title you have, filled by how far you are in it. */
  readonly progress?: readonly number[] | undefined;
}

/**
 * The seasons of one show as a single tile (doc 08 §3): a stack of covers, the first title's name
 * in the reader's title language, and "8 seasons · 16 movies, specials and spin-offs". It opens the
 * franchise page, where the seasons, the other titles and their episodes are.
 */
export function FranchiseTile({ franchise, covers, standing, progress }: TileProps) {
  const name = displayTitle(franchise);
  const counts = franchiseSummary(franchise);
  // The franchise's own covers (its first titles), so a tile looks the same whether one season or
  // all of them are on the page; the page's own covers are the fallback.
  const own = franchise.covers.map((coverUrl, index) => ({
    id: `${franchise.id}-${index}`,
    coverUrl,
  }));
  const base = own.length > 0 ? own : covers;
  // Always a stack of three: a franchise with one or two covers known repeats them, so every tile
  // has the same shape.
  const shown =
    base.length === 0
      ? []
      : Array.from({ length: 3 }, (_, index) => ({
          ...base[index % base.length]!,
          id: `${base[index % base.length]!.id}-${index}`,
        }));
  return (
    <Link to={`/franchise/${franchise.id}`} className="ftile has-[:focus-visible]:outline-accent">
      <span className="sr-only">Franchise</span>{' '}
      <span className="ftile__art" aria-hidden="true">
        {shown.map((cover) =>
          cover.coverUrl === null ? (
            <span
              key={cover.id}
              className="ftile__ph"
              style={{ background: stockFor({ id: cover.id }) }}
            />
          ) : (
            <img key={cover.id} src={cover.coverUrl} alt="" loading="lazy" decoding="async" />
          ),
        )}
      </span>
      {progress !== undefined && progress.length > 0 && (
        <span className="ftile__bar" aria-hidden="true">
          {progress.map((fraction, index) => (
            <i key={index} style={{ '--w': `${Math.round(fraction * 100)}%` } as CSSProperties} />
          ))}
        </span>
      )}
      <span className="ftile__name">{name}</span> <span className="ftile__meta">{counts}</span>
      {standing !== undefined && (
        <>
          {' '}
          <span className="ftile__meta ftile__meta--you">{standing}</span>
        </>
      )}
    </Link>
  );
}
