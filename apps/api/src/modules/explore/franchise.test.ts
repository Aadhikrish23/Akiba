import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../testing/database.js';
import {
  groupFranchises,
  MAX_FRANCHISE_SIZE,
  recomputeAllFranchises,
  recomputeFranchises,
  type FranchiseEdge,
} from './franchise.js';

type Edge = FranchiseEdge;
const edge = (from: string, to: string, type: Edge['type'] = 'sequel'): Edge => ({
  from,
  to,
  type,
});
const ids = (n: number, prefix = 't'): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(3, '0')}`);
const normal = (groups: readonly (readonly string[])[]): string[][] =>
  groups.map((group) => [...group].sort()).sort((a, b) => a[0]!.localeCompare(b[0]!));

/** A small deterministic generator, so a failure can be replayed from its seed. */
function prng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

describe('groupFranchises (T21, FR-EXP-001)', () => {
  it('joins titles linked by a chain of relations, whichever way the arrows point', () => {
    const groups = groupFranchises(
      ['a', 'b', 'c', 'd', 'e'],
      [edge('a', 'b', 'sequel'), edge('c', 'b', 'prequel'), edge('c', 'd', 'spin_off')],
    );
    expect(normal(groups)).toEqual([['a', 'b', 'c', 'd']]); // e has no relations: no franchise
  });

  it('does not let "other" or "adaptation" join anything', () => {
    expect(
      groupFranchises(['a', 'b', 'c'], [edge('a', 'b', 'other'), edge('b', 'c', 'adaptation')]),
    ).toEqual([]);
  });

  it('does not depend on the order the relations arrive in', () => {
    const nodes = ids(30);
    const random = prng(7);
    const edges: Edge[] = [];
    for (let i = 0; i < 24; i += 1) {
      edges.push(
        edge(nodes[Math.floor(random() * 30)]!, nodes[Math.floor(random() * 30)]!, 'side_story'),
      );
    }
    const expected = normal(groupFranchises(nodes, edges));
    for (let run = 0; run < 5; run += 1) {
      const shuffled = [...edges].sort(() => random() - 0.5);
      expect(normal(groupFranchises([...nodes].reverse(), shuffled))).toEqual(expected);
    }
  });

  it('a curated long franchise groups as one, and a crossover through "other" does not merge two', () => {
    // Fate-like: three main works, each with sequels and side stories, plus movies, and a separate
    // franchise connected to it only by an "other" crossover link.
    const fate = ids(40, 'fate');
    const edges: Edge[] = [];
    for (let i = 1; i < 30; i += 1) edges.push(edge(fate[i - 1]!, fate[i]!, 'sequel'));
    for (let i = 30; i < 40; i += 1)
      edges.push(edge(fate[i - 20]!, fate[i]!, i % 2 === 0 ? 'spin_off' : 'side_story'));
    const other = ids(6, 'nasu');
    for (let i = 1; i < 6; i += 1) edges.push(edge(other[i - 1]!, other[i]!, 'prequel'));
    edges.push(edge('fate005', 'nasu002', 'other'));
    const lone = 'solo';

    const groups = normal(groupFranchises([...fate, ...other, lone], edges));
    expect(groups).toEqual(normal([fate, other]));
  });

  it('splits a group above the cap using the main line only, and drops pieces still too large', () => {
    // Two long main lines joined through a spin-off bridge: together over the cap.
    const a = ids(80, 'a');
    const b = ids(80, 'b');
    const edges: Edge[] = [];
    for (let i = 1; i < 80; i += 1) {
      edges.push(edge(a[i - 1]!, a[i]!, 'sequel'), edge(b[i - 1]!, b[i]!, 'sequel'));
    }
    edges.push(edge('a010', 'b010', 'spin_off'));
    const groups = groupFranchises([...a, ...b], edges);
    expect(groups.every((group) => group.length <= MAX_FRANCHISE_SIZE)).toBe(true);
    expect(normal(groups)).toEqual(normal([a, b])); // the bridge no longer joins them

    // A main line that is itself over the cap gets no franchise at all.
    const huge = ids(MAX_FRANCHISE_SIZE + 5, 'h');
    const chain = huge.slice(1).map((id, i) => edge(huge[i]!, id, 'sequel'));
    expect(groupFranchises(huge, chain)).toEqual([]);
  });
});

/**
 * The database side: franchises are kept in step as relations change, and what is stored always
 * equals what a from-scratch computation says. Random edits, replayed from a seed.
 */
describe('recomputeFranchises (T21) on PostgreSQL', () => {
  let testDb: TestDatabase;
  let titleIds: string[];

  beforeAll(async () => {
    testDb = await createTestDatabase();
  });
  afterAll(async () => {
    await testDb.drop();
  });
  beforeEach(async () => {
    await testDb.reset();
    titleIds = [];
  });

  async function seedTitles(n: number): Promise<string[]> {
    const created: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const row = await testDb.sql.query<{ id: string }>(
        `INSERT INTO title (kind, status, title_romaji, start_date, popularity, fetched_at)
         VALUES ('tv', 'finished', $1, $2, $3, now()) RETURNING id`,
        [
          `Title ${String(i).padStart(2, '0')}`,
          `2010-01-${String((i % 28) + 1).padStart(2, '0')}`,
          1000 - i,
        ],
      );
      created.push(row.rows[0]!.id);
    }
    titleIds = created;
    return created;
  }
  const link = (from: string, to: string, type = 'sequel') =>
    testDb.sql.query(
      `INSERT INTO title_relation (from_title_id, to_title_id, relation_type) VALUES ($1, $2, $3::relation_type)
       ON CONFLICT DO NOTHING`,
      [from, to, type],
    );
  const unlink = (from: string, to: string) =>
    testDb.sql.query(`DELETE FROM title_relation WHERE from_title_id = $1 AND to_title_id = $2`, [
      from,
      to,
    ]);
  const recompute = (seeds: string[]) =>
    testDb.db.client.$transaction((tx) => recomputeFranchises(tx, seeds));
  const franchiseCount = async (): Promise<number> =>
    Number(
      (await testDb.sql.query<{ n: string }>(`SELECT count(*) AS n FROM franchise`)).rows[0]!.n,
    );
  const emptyFranchises = async (): Promise<number> =>
    Number(
      (
        await testDb.sql.query<{ n: string }>(
          `SELECT count(*) AS n FROM franchise f WHERE NOT EXISTS (SELECT 1 FROM title t WHERE t.franchise_id = f.id)`,
        )
      ).rows[0]!.n,
    );
  const stored = async (): Promise<Map<string, string>> =>
    new Map(
      (
        await testDb.sql.query<{ id: string; franchise_id: string }>(
          `SELECT id, franchise_id FROM title WHERE franchise_id IS NOT NULL`,
        )
      ).rows.map((row) => [row.id, row.franchise_id]),
    );
  const storedGroups = async (): Promise<string[][]> => {
    const byFranchise = new Map<string, string[]>();
    for (const [title, franchise] of await stored()) {
      byFranchise.set(franchise, [...(byFranchise.get(franchise) ?? []), title]);
    }
    return normal([...byFranchise.values()]);
  };
  const expectedGroups = async (): Promise<string[][]> => {
    const edges = (
      await testDb.sql.query<{ f: string; t: string; ty: Edge['type'] }>(
        `SELECT from_title_id AS f, to_title_id AS t, relation_type::text AS ty FROM title_relation`,
      )
    ).rows.map((row) => edge(row.f, row.t, row.ty));
    return normal(groupFranchises(titleIds, edges));
  };

  it('creates a franchise for a new relation, named after its earliest title', async () => {
    const [a, b, c] = await seedTitles(3);
    await link(b!, a!, 'prequel');
    await link(b!, c!, 'sequel');
    await recompute([b!]);
    expect(await storedGroups()).toEqual(normal([[a!, b!, c!]]));
    const names = (await testDb.sql.query<{ name: string }>(`SELECT name FROM franchise`)).rows;
    expect(names).toEqual([{ name: 'Title 00' }]);
  });

  it('keeps the franchise ID when it grows, and the larger one when two merge', async () => {
    const t = await seedTitles(7);
    await link(t[0]!, t[1]!);
    await link(t[1]!, t[2]!);
    await recompute([t[0]!]);
    await link(t[4]!, t[5]!);
    await recompute([t[4]!]);
    const before = await stored();
    const bigId = before.get(t[0]!)!;
    const smallId = before.get(t[4]!)!;
    expect(bigId).not.toBe(smallId);

    await link(t[2]!, t[3]!); // grows
    await recompute([t[2]!]);
    expect((await stored()).get(t[3]!)).toBe(bigId);

    await link(t[3]!, t[4]!, 'spin_off'); // merges the two
    await recompute([t[3]!]);
    const merged = await stored();
    expect(new Set([t[0]!, t[1]!, t[2]!, t[3]!, t[4]!, t[5]!].map((id) => merged.get(id)))).toEqual(
      new Set([bigId]),
    );
    expect(await franchiseCount()).toBe(1);
  });

  it('splits a franchise when a relation goes away, keeping the ID on the larger half', async () => {
    const t = await seedTitles(6);
    for (let i = 1; i < 6; i += 1) await link(t[i - 1]!, t[i]!);
    await recompute([t[0]!]);
    const original = (await stored()).get(t[0]!)!;

    await unlink(t[3]!, t[4]!); // {0,1,2,3} | {4,5}
    await recompute([t[3]!]);
    const after = await stored();
    expect(after.get(t[0]!)).toBe(original);
    expect(after.get(t[3]!)).toBe(original);
    expect(after.get(t[4]!)).toBe(after.get(t[5]!));
    expect(after.get(t[4]!)).not.toBe(original);

    // Cut a single title loose: it loses its franchise, and an emptied franchise is deleted.
    await unlink(t[4]!, t[5]!);
    await recompute([t[4]!]);
    const last = await stored();
    expect(last.has(t[4]!)).toBe(false);
    expect(last.has(t[5]!)).toBe(false);
    expect(await franchiseCount()).toBe(1);
  });

  it('after any sequence of edits the stored franchises equal a fresh computation (seeded)', async () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      await testDb.reset();
      const nodes = await seedTitles(18);
      const random = prng(seed);
      const types = [
        'sequel',
        'prequel',
        'side_story',
        'spin_off',
        'other',
        'adaptation',
        'alternative',
      ];
      for (let step = 0; step < 40; step += 1) {
        const from = nodes[Math.floor(random() * nodes.length)]!;
        const to = nodes[Math.floor(random() * nodes.length)]!;
        if (from === to) continue;
        if (random() < 0.3) await unlink(from, to);
        else await link(from, to, types[Math.floor(random() * types.length)]);
        await recompute([from]); // like a refresh of `from`: it drops or adds its own edges
        expect(await storedGroups(), `seed ${seed} step ${step}`).toEqual(await expectedGroups());
      }
      // And a full rebuild changes nothing.
      const before = await storedGroups();
      await recomputeAllFranchises(testDb.db.client);
      expect(await storedGroups()).toEqual(before);
      // A franchise row exists only while it has titles.
      expect(await emptyFranchises()).toBe(0);
    }
  }, 120_000);

  it('simultaneous recomputations never leave a title in two franchises or lose a link', async () => {
    const t = await seedTitles(12);
    for (let i = 1; i < 6; i += 1) await link(t[i - 1]!, t[i]!);
    for (let i = 7; i < 12; i += 1) await link(t[i - 1]!, t[i]!);
    await Promise.all([recompute([t[2]!]), recompute([t[9]!]), recompute([t[0]!, t[11]!])]);
    expect(await storedGroups()).toEqual(await expectedGroups());
    // Now bridge the halves from two directions at once.
    await link(t[5]!, t[6]!);
    await Promise.all([recompute([t[5]!]), recompute([t[6]!])]);
    expect(await storedGroups()).toEqual(await expectedGroups());
    expect((await storedGroups()).length).toBe(1);
  });
});
