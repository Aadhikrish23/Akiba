import type { TitleCard } from '@akiba/shared';

export type FranchiseInfo = NonNullable<TitleCard['franchise']>;

/** Either one item on its own, or two or more that belong to one franchise (a banner). */
export type Grouped<T> =
  | { readonly kind: 'one'; readonly key: string; readonly item: T }
  | {
      readonly kind: 'banner';
      readonly key: string;
      readonly franchise: FranchiseInfo;
      readonly items: readonly T[];
    };

/**
 * Put the seasons of one show together: items that share a franchise become one banner, placed
 * where the first of them was and holding the rest in their original order. A franchise with only
 * one item in the list is not worth a banner, so that item stays as it is.
 */
export function groupByFranchise<T>(
  items: readonly T[],
  franchiseOf: (item: T) => FranchiseInfo | null,
  keyOf: (item: T) => string,
): Grouped<T>[] {
  const members = new Map<string, T[]>();
  for (const item of items) {
    const franchise = franchiseOf(item);
    if (franchise === null) continue;
    members.set(franchise.id, [...(members.get(franchise.id) ?? []), item]);
  }
  const out: Grouped<T>[] = [];
  const placed = new Set<string>();
  for (const item of items) {
    const franchise = franchiseOf(item);
    const together = franchise === null ? undefined : members.get(franchise.id);
    if (franchise === null || together === undefined || together.length < 2) {
      out.push({ kind: 'one', key: keyOf(item), item });
    } else if (!placed.has(franchise.id)) {
      placed.add(franchise.id);
      out.push({ kind: 'banner', key: `franchise-${franchise.id}`, franchise, items: together });
    }
  }
  return out;
}

/** "8 seasons · 16 movies, specials and spin-offs", or just "24 titles" while the seasons are not counted. */
export function franchiseSummary(franchise: FranchiseInfo): string {
  const { seasons, size } = franchise;
  if (seasons === null || seasons === 0) return `${size} titles`;
  const others = size - seasons;
  const head = `${seasons} ${seasons === 1 ? 'season' : 'seasons'}`;
  if (others <= 0) return head;
  return `${head} · ${others} ${others === 1 ? 'movie, special or spin-off' : 'movies, specials and spin-offs'}`;
}
