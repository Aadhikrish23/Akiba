import type { RelationType } from '@akiba/shared';
import { Prisma, type DbClient, type DbTransaction } from '../../db/index.js';

/**
 * Franchises (doc 06: "connected components of `title_relation`, recomputed when relations change").
 *
 * Two titles are in one franchise when a chain of relations of the kinds below links them, in
 * either direction. Two guards keep a franchise meaningful:
 *
 *  - `other` links anything to anything (crossovers, "shares a character") and `adaptation` points
 *    at a different medium, so neither joins titles;
 *  - a group larger than {@link MAX_FRANCHISE_SIZE} is probably several franchises joined by a
 *    loose link. It is split again using only the main line (prequel/sequel/parent story); a piece
 *    that is still too large gets no franchise at all (the title page still lists its relations).
 */

/** Relation kinds that put two titles in one franchise. */
export const FRANCHISE_RELATIONS: readonly RelationType[] = [
  'prequel',
  'sequel',
  'side_story',
  'spin_off',
  'parent_story',
  'alternative',
  'summary',
];

/** The narrower set used to split a group that is too large. */
export const MAIN_LINE_RELATIONS: readonly RelationType[] = ['prequel', 'sequel', 'parent_story'];

export const MAX_FRANCHISE_SIZE = 120;

/** Stop growing the set of affected titles here (a runaway graph): the franchise is left as it was. */
const CLOSURE_LIMIT = 5_000;

export interface FranchiseEdge {
  readonly from: string;
  readonly to: string;
  readonly type: RelationType;
}

/** Union-find over string IDs. */
class Groups {
  readonly #parent = new Map<string, string>();

  find(id: string): string {
    let root = id;
    for (;;) {
      const parent = this.#parent.get(root);
      if (parent === undefined || parent === root) break;
      root = parent;
    }
    // Path compression.
    let node = id;
    while (node !== root) {
      const next = this.#parent.get(node) ?? root;
      this.#parent.set(node, root);
      node = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    // The smaller ID is the root, so the result does not depend on the order of the edges.
    if (ra < rb) this.#parent.set(rb, ra);
    else this.#parent.set(ra, rb);
  }
}

function components(
  ids: readonly string[],
  edges: readonly FranchiseEdge[],
  allowed: readonly RelationType[],
): string[][] {
  const known = new Set(ids);
  const groups = new Groups();
  for (const id of ids) groups.find(id);
  for (const edge of edges) {
    if (allowed.includes(edge.type) && known.has(edge.from) && known.has(edge.to)) {
      groups.union(edge.from, edge.to);
    }
  }
  const byRoot = new Map<string, string[]>();
  for (const id of ids) {
    const root = groups.find(id);
    const list = byRoot.get(root);
    if (list === undefined) byRoot.set(root, [id]);
    else list.push(id);
  }
  return [...byRoot.values()];
}

/**
 * The franchises among `ids`: groups of two or more titles, never larger than `cap`. Pure, so the
 * rules can be tested on any graph. Titles in no group have no franchise.
 */
export function groupFranchises(
  ids: readonly string[],
  edges: readonly FranchiseEdge[],
  cap = MAX_FRANCHISE_SIZE,
): string[][] {
  const result: string[][] = [];
  for (const group of components(ids, edges, FRANCHISE_RELATIONS)) {
    if (group.length < 2) continue;
    if (group.length <= cap) {
      result.push(group);
      continue;
    }
    for (const piece of components(group, edges, MAIN_LINE_RELATIONS)) {
      if (piece.length >= 2 && piece.length <= cap) result.push(piece);
    }
  }
  return result.map((group) => [...group].sort());
}

// ── Keeping the database in step ──────────────────────────────────────────────

interface TitleInfo {
  readonly id: string;
  readonly franchiseId: string | null;
  readonly name: string;
  readonly startDate: string;
  readonly popularity: number;
}

/** The title a franchise is named after: the earliest to start, then the most popular. */
export function pickRoot(group: readonly TitleInfo[]): TitleInfo {
  return [...group].sort(
    (a, b) =>
      a.startDate.localeCompare(b.startDate) ||
      b.popularity - a.popularity ||
      a.id.localeCompare(b.id),
  )[0]!;
}

const sqlIds = (ids: readonly string[]) => Prisma.sql`${[...ids]}::uuid[]`;

async function edgesTouching(
  tx: DbTransaction,
  ids: readonly string[],
): Promise<readonly FranchiseEdge[]> {
  if (ids.length === 0) return [];
  return tx.$queryRaw<FranchiseEdge[]>`
    SELECT from_title_id::text AS "from", to_title_id::text AS "to", relation_type::text AS "type"
    FROM title_relation
    WHERE relation_type::text = ANY(${[...FRANCHISE_RELATIONS]}::text[])
      AND (from_title_id = ANY(${sqlIds(ids)}) OR to_title_id = ANY(${sqlIds(ids)}))`;
}

/**
 * Bring franchises up to date around `seeds` (the titles whose relations just changed). Run inside
 * the transaction that changed them; concurrent recomputations queue on an advisory lock, so two
 * refreshes cannot hand one title two franchises.
 *
 * The affected set is closed under "linked by a relation" and "was in the same franchise", so the
 * pieces computed inside it are exactly the global pieces, and a franchise that split in two (a
 * relation went away) is split in the database too. Franchise IDs are kept where they can be: the
 * piece holding most of an old franchise's titles keeps its ID, so links to it keep working.
 */
export async function recomputeFranchises(
  tx: DbTransaction,
  seeds: readonly string[],
): Promise<void> {
  if (seeds.length === 0) return;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('akiba:franchise', 0))`;

  const affected = new Set<string>(seeds);
  const oldFranchises = new Set<string>();
  let edges: FranchiseEdge[] = [];
  let frontier: string[] = [...affected];
  while (frontier.length > 0) {
    const found = await edgesTouching(tx, frontier);
    edges = [...edges, ...found];
    const added = new Set<string>();
    for (const edge of found) {
      for (const id of [edge.from, edge.to]) if (!affected.has(id)) added.add(id);
    }
    // Everything that was in one of the franchises we have touched comes along.
    const seen = [...affected, ...added];
    const franchises = await tx.title.findMany({
      where: { id: { in: seen }, franchiseId: { not: null } },
      select: { franchiseId: true },
    });
    const fresh = franchises
      .map((row) => row.franchiseId)
      .filter((id): id is string => id !== null && !oldFranchises.has(id));
    for (const id of fresh) oldFranchises.add(id);
    if (fresh.length > 0) {
      const members = await tx.title.findMany({
        where: { franchiseId: { in: fresh } },
        select: { id: true },
      });
      for (const member of members) if (!affected.has(member.id)) added.add(member.id);
    }
    for (const id of added) affected.add(id);
    if (affected.size > CLOSURE_LIMIT) return; // runaway graph: leave the franchises as they were
    frontier = [...added];
  }

  const ids = [...affected];
  const rows = await tx.title.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      franchiseId: true,
      titleRomaji: true,
      titleEnglish: true,
      titleNative: true,
      startDate: true,
      popularity: true,
    },
  });
  const info = new Map<string, TitleInfo>(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        franchiseId: row.franchiseId,
        name: row.titleRomaji ?? row.titleEnglish ?? row.titleNative ?? 'Untitled',
        startDate: row.startDate?.toISOString().slice(0, 10) ?? '9999-12-31',
        popularity: row.popularity ?? 0,
      },
    ]),
  );

  const groups = groupFranchises(
    ids.filter((id) => info.has(id)),
    edges,
  ).sort((a, b) => b.length - a.length || a[0]!.localeCompare(b[0]!));

  const inGroup = new Set<string>();
  const taken = new Set<string>();
  for (const group of groups) {
    const members = group.map((id) => info.get(id)!);
    // The old franchise holding most of these titles keeps its ID (ties: the smaller ID).
    const votes = new Map<string, number>();
    for (const member of members) {
      if (member.franchiseId !== null && !taken.has(member.franchiseId)) {
        votes.set(member.franchiseId, (votes.get(member.franchiseId) ?? 0) + 1);
      }
    }
    const kept = [...votes.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0]?.[0];
    const name = pickRoot(members).name;
    let franchiseId: string;
    if (kept === undefined) {
      franchiseId = (await tx.franchise.create({ data: { name }, select: { id: true } })).id;
    } else {
      franchiseId = kept;
      await tx.franchise.update({ where: { id: kept }, data: { name } });
    }
    taken.add(franchiseId);
    await tx.title.updateMany({ where: { id: { in: group } }, data: { franchiseId } });
    for (const id of group) inGroup.add(id);
  }

  // Titles that are no longer in any group lose their franchise; empty franchises go.
  const loose = ids.filter((id) => !inGroup.has(id) && info.get(id)?.franchiseId != null);
  if (loose.length > 0) {
    await tx.title.updateMany({ where: { id: { in: loose } }, data: { franchiseId: null } });
  }
  const empty = [...oldFranchises].filter((id) => !taken.has(id));
  if (empty.length > 0) {
    await tx.franchise.deleteMany({ where: { id: { in: empty }, titles: { none: {} } } });
  }
}

/** Recompute every franchise from the relations (repair, or after a bulk import). */
export async function recomputeAllFranchises(db: DbClient): Promise<void> {
  const linked = await db.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT id::text AS id FROM (
      SELECT from_title_id AS id FROM title_relation
      UNION SELECT to_title_id FROM title_relation
      UNION SELECT id FROM title WHERE franchise_id IS NOT NULL
    ) AS ids`;
  await db.$transaction(
    (tx) =>
      recomputeFranchises(
        tx,
        linked.map((row) => row.id),
      ),
    { timeout: 120_000 },
  );
}
