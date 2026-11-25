import type { TitleCard } from '@akiba/shared';

export type FranchiseInfo = NonNullable<TitleCard['franchise']>;

/** Either one item that belongs to no franchise, or the items of one franchise on the page (a tile). */
export type Grouped<T> =
  | { readonly kind: 'one'; readonly key: string; readonly item: T }
  | {
      readonly kind: 'banner';
      readonly key: string;
      readonly franchise: FranchiseInfo;
      readonly items: readonly T[];
    };

/**
 * Put the seasons of one show together: items that share a franchise become one tile, placed
 * where the first of them was and holding the rest in their original order. `minItems` is how many
 * of a franchise must be in the list for a tile: 2 by default (a shelf of what you track keeps a
 * lone season as the entry it is, with its +1), 1 in Discover, where a title that belongs to a
 * franchise is its tile even when it is the only one of them on the page, so Browse and search agree.
 */
export function groupByFranchise<T>(
  items: readonly T[],
  franchiseOf: (item: T) => FranchiseInfo | null,
  keyOf: (item: T) => string,
  minItems = 2,
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
    if (franchise === null || together === undefined || together.length < minItems) {
      out.push({ kind: 'one', key: keyOf(item), item });
    } else if (!placed.has(franchise.id)) {
      placed.add(franchise.id);
      out.push({ kind: 'banner', key: `franchise-${franchise.id}`, franchise, items: together });
    }
  }
  return out;
}

/**
 * The seasons in the order they follow each other. A sequel comes after the title it follows even
 * when it is not known to have started yet (a placeholder has no date); titles that do not depend on
 * each other keep the order they came in (oldest first).
 */
export function inSeasonOrder<T extends { readonly id: string }>(
  titles: readonly T[],
  edges: readonly { readonly from: string; readonly to: string; readonly type: string }[],
): T[] {
  const ids = new Set(titles.map((title) => title.id));
  const before = new Map<string, Set<string>>(titles.map((title) => [title.id, new Set()]));
  for (const edge of edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) continue;
    // "from is the sequel of to" and "to is the prequel of from" both mean: to comes first.
    if (edge.type === 'prequel') before.get(edge.from)?.add(edge.to);
    if (edge.type === 'sequel') before.get(edge.to)?.add(edge.from);
  }
  const out: T[] = [];
  const placed = new Set<string>();
  while (out.length < titles.length) {
    const ready =
      titles.find(
        (title) =>
          !placed.has(title.id) && [...before.get(title.id)!].every((id) => placed.has(id)),
      ) ?? titles.find((title) => !placed.has(title.id))!; // a cycle: keep going in the order given
    placed.add(ready.id);
    out.push(ready);
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
