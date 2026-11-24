/** A relation between two titles: `from` relates to `to` the way `type` says. */
export interface MainLineEdge {
  readonly from: string;
  readonly to: string;
  readonly type: string;
}

/**
 * The titles on the main line of a franchise: everything reachable from `rootId` through prequel and
 * sequel links, in either direction. Season 2 and season 3 are on it; a spin-off or a movie that
 * only hangs off the side (side story, spin-off, parent story, summary) is not.
 */
export function mainLineOf(rootId: string, edges: readonly MainLineEdge[]): Set<string> {
  const next = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.type !== 'prequel' && edge.type !== 'sequel') continue;
    next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to]);
    next.set(edge.to, [...(next.get(edge.to) ?? []), edge.from]);
  }
  const line = new Set<string>([rootId]);
  const queue = [rootId];
  for (let index = 0; index < queue.length; index += 1) {
    for (const id of next.get(queue[index]!) ?? []) {
      if (line.has(id)) continue;
      line.add(id);
      queue.push(id);
    }
  }
  return line;
}
