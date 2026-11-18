import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../testing/database.js';
import { makeSourceTitle } from '../testing/sources.js';
import { importDataset } from './dataset.js';
import { setOverride } from './overrides.js';
import { UnresolvableTitleError, createTitleResolver, type TitleResolver } from './resolver.js';

/** Doc 11 §3.3 "Akiba ID mapping" (blocks M1), resolver half. Real PostgreSQL. */
describe('Akiba ID resolver (D-03, doc 05 §5)', () => {
  let testDb: TestDatabase;
  let resolver: TitleResolver;

  beforeAll(async () => {
    testDb = await createTestDatabase();
  });
  afterAll(async () => {
    await testDb.drop();
  });
  beforeEach(async () => {
    await testDb.reset();
    resolver = createTitleResolver(testDb.db.client);
  });

  const count = async (table: string): Promise<number> =>
    Number(
      (await testDb.sql.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n,
    );
  const idsOf = async (titleId: string): Promise<string[]> =>
    (
      await testDb.sql.query<{ k: string }>(
        `SELECT source || ':' || external_id AS k FROM title_external_id WHERE title_id = $1 ORDER BY 1`,
        [titleId],
      )
    ).rows.map((row) => row.k);
  const openConflicts = async () =>
    (
      await testDb.sql.query<{ reason: string }>(
        `SELECT reason FROM mapping_conflict WHERE resolved_at IS NULL`,
      )
    ).rows;

  it('creates a title with the IDs the source reported', async () => {
    const result = await resolver.resolve({
      externalIds: { anilist: '16498', mal: '16498' },
      title: makeSourceTitle({
        externalIds: { anilist: '16498', mal: '16498' },
        titleRomaji: 'Shingeki no Kyojin',
        titleEnglish: 'Attack on Titan',
        titleNative: '進撃の巨人',
        episodesTotal: 25,
        season: 'spring',
        seasonYear: 2013,
        startDate: { year: 2013, month: 4, day: 7 },
        endDate: { year: 2013, month: null, day: null },
      }),
    });
    expect(result).toMatchObject({ matchedBy: 'created', created: true, conflicts: 0 });
    expect(await idsOf(result.titleId)).toEqual(['anilist:16498', 'mal:16498']);

    const row = (
      await testDb.sql.query<Record<string, unknown>>(
        `SELECT title_romaji, title_english, title_native, kind, status, episodes_total, season,
                season_year, start_date::text AS start_date, end_date, fetched_at, stale
         FROM title WHERE id = $1`,
        [result.titleId],
      )
    ).rows[0];
    expect(row).toMatchObject({
      title_romaji: 'Shingeki no Kyojin',
      title_english: 'Attack on Titan',
      title_native: '進撃の巨人',
      kind: 'tv',
      status: 'finished',
      episodes_total: 25,
      season: 'spring',
      season_year: 2013,
      start_date: '2013-04-07',
      end_date: null, // a year alone does not fit a `date` column
      stale: false,
    });
    expect(row?.fetched_at).not.toBeNull();
  });

  it('FR-DISC (doc 11 §3.3): the same title from AniList and from MAL is ONE Akiba ID', async () => {
    const fromAniList = await resolver.resolve({
      externalIds: { anilist: '16498', mal: '16498' },
      title: makeSourceTitle({ externalIds: { anilist: '16498', mal: '16498' } }),
    });
    // Later the fallback source answers with the MAL ID only.
    const fromJikan = await resolver.resolve({ externalIds: { mal: '16498' } });
    expect(fromJikan).toMatchObject({
      titleId: fromAniList.titleId,
      matchedBy: 'external_id',
      created: false,
    });
    expect(await count('title')).toBe(1);
  });

  it('a title first seen through MAL later gains its AniList ID', async () => {
    const first = await resolver.resolve({
      externalIds: { mal: '700' },
      title: makeSourceTitle({ externalIds: { mal: '700' } }),
    });
    const second = await resolver.resolve({
      externalIds: { anilist: '900', mal: '700' },
      title: makeSourceTitle({ externalIds: { anilist: '900', mal: '700' } }),
    });
    expect(second.titleId).toBe(first.titleId);
    expect(await idsOf(first.titleId)).toEqual(['anilist:900', 'mal:700']);
    expect(await openConflicts()).toEqual([]);
  });

  it('is idempotent: resolving the same title again changes nothing', async () => {
    const input = {
      externalIds: { anilist: '1', mal: '2' },
      title: makeSourceTitle({ externalIds: { anilist: '1', mal: '2' } }),
    };
    const first = await resolver.resolve(input);
    for (let i = 0; i < 5; i += 1) {
      const again = await resolver.resolve(input);
      expect(again).toMatchObject({ titleId: first.titleId, created: false, conflicts: 0 });
    }
    expect(await count('title')).toBe(1);
    expect(await count('title_external_id')).toBe(2);
    expect(await count('mapping_conflict')).toBe(0);
  });

  it('concurrent resolution of the same external ID creates exactly one row', async () => {
    const input = {
      externalIds: { anilist: '16498', mal: '16498' },
      title: makeSourceTitle({ externalIds: { anilist: '16498', mal: '16498' } }),
    };
    const results = await Promise.all(Array.from({ length: 12 }, () => resolver.resolve(input)));
    expect(new Set(results.map((result) => result.titleId)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(await count('title')).toBe(1);
    expect(await count('title_external_id')).toBe(2);
  });

  it.each([
    ['share the MAL ID', { mal: '2' }],
    ['share the AniList ID', { anilist: '1' }],
  ])(
    'concurrent resolutions that only OVERLAP in their IDs (they %s) agree on one title',
    async (_label, partial) => {
      const full = { anilist: '1', mal: '2' };
      const inputs = [
        { externalIds: full, title: makeSourceTitle({ externalIds: full }) },
        { externalIds: partial, title: makeSourceTitle({ externalIds: partial }) },
      ];
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => resolver.resolve(inputs[i % 2] ?? inputs[0]!)),
      );
      expect(new Set(results.map((result) => result.titleId)).size).toBe(1);
      expect(await count('title')).toBe(1);
    },
  );

  it('records, rather than hides, two titles that were created apart and only later seen together', async () => {
    // Nothing links them until one record carries both IDs; then the disagreement is queued
    // for the merge script (doc 05 §5) instead of being guessed at.
    const a = await resolver.resolve({
      externalIds: { mal: '2' },
      title: makeSourceTitle({ externalIds: { mal: '2' } }),
    });
    const b = await resolver.resolve({
      externalIds: { anilist: '1' },
      title: makeSourceTitle({ externalIds: { anilist: '1' } }),
    });
    expect(b.titleId).not.toBe(a.titleId);
    const both = await resolver.resolve({ externalIds: { anilist: '1', mal: '2' } });
    expect(both.titleId).toBe(b.titleId); // AniList is the identity
    expect(both.conflicts).toBeGreaterThan(0);
    expect(await openConflicts()).toHaveLength(1);
  });

  describe('tricky cases (doc 11 §3.3 fixture set)', () => {
    it('split-cour: two AniList entries that share one MAL entry stay TWO titles, and the clash is queued', async () => {
      const cour1 = await resolver.resolve({
        externalIds: { anilist: '100', mal: '500' },
        title: makeSourceTitle({
          externalIds: { anilist: '100', mal: '500' },
          titleRomaji: 'Show Part 1',
        }),
      });
      const cour2 = await resolver.resolve({
        externalIds: { anilist: '101', mal: '500' },
        title: makeSourceTitle({
          externalIds: { anilist: '101', mal: '500' },
          titleRomaji: 'Show Part 2',
        }),
      });
      expect(cour2.titleId).not.toBe(cour1.titleId);
      expect(cour2).toMatchObject({ created: true });
      expect(cour2.conflicts).toBeGreaterThan(0);
      // MAL's shared ID stays with the first; the second is identified by AniList alone.
      expect(await idsOf(cour1.titleId)).toEqual(['anilist:100', 'mal:500']);
      expect(await idsOf(cour2.titleId)).toEqual(['anilist:101']);
      expect(await openConflicts()).toHaveLength(1);

      // Resolving again does not pile up duplicate conflicts and does not merge them.
      const again = await resolver.resolve({
        externalIds: { anilist: '101', mal: '500' },
        title: makeSourceTitle({ externalIds: { anilist: '101', mal: '500' } }),
      });
      expect(again.titleId).toBe(cour2.titleId);
      expect(await openConflicts()).toHaveLength(1);
      expect(await count('title')).toBe(2);
    });

    it.each([
      ['a movie and its TV series', { anilist: '10' }, { anilist: '11' }],
      [
        'a recap special and the series',
        { anilist: '20', mal: '20' },
        { anilist: '21', mal: '21' },
      ],
      ['a remake and the original', { anilist: '30', mal: '30' }, { anilist: '31', mal: '31' }],
    ])('%s are separate titles', async (_label, a, b) => {
      const first = await resolver.resolve({
        externalIds: a,
        title: makeSourceTitle({ externalIds: a }),
      });
      const second = await resolver.resolve({
        externalIds: b,
        title: makeSourceTitle({ externalIds: b }),
      });
      expect(second.titleId).not.toBe(first.titleId);
      expect(await openConflicts()).toEqual([]);
    });

    it('titles with no counterpart at the other source resolve on the ID they have', async () => {
      const anilistOnly = await resolver.resolve({
        externalIds: { anilist: '40' },
        title: makeSourceTitle({ externalIds: { anilist: '40' } }),
      });
      const malOnly = await resolver.resolve({
        externalIds: { mal: '41' },
        title: makeSourceTitle({ externalIds: { mal: '41' } }),
      });
      expect(anilistOnly.titleId).not.toBe(malOnly.titleId);
      expect(await idsOf(anilistOnly.titleId)).toEqual(['anilist:40']);
      expect(await idsOf(malOnly.titleId)).toEqual(['mal:41']);
    });
  });

  describe('the mapping dataset', () => {
    it('links a title first seen at AniList to the one already known through MAL', async () => {
      const viaJikan = await resolver.resolve({
        externalIds: { mal: '700' },
        title: makeSourceTitle({ externalIds: { mal: '700' } }),
      });
      // A dataset row the importer has not applied yet (it ran before the title existed, say).
      await testDb.sql.query(
        `INSERT INTO mapping_dataset_entry (anilist_id, mal_id, kitsu_id) VALUES ('900', '700', '55')`,
      );

      // AniList reports no MAL ID for this entry; only the dataset knows they are one title.
      const viaAniList = await resolver.resolve({
        externalIds: { anilist: '900' },
        title: makeSourceTitle({ externalIds: { anilist: '900' } }),
      });
      expect(viaAniList).toMatchObject({
        titleId: viaJikan.titleId,
        matchedBy: 'dataset',
        created: false,
      });
      expect(await idsOf(viaJikan.titleId)).toEqual(['anilist:900', 'kitsu:55', 'mal:700']);
    });

    it('a new title also gets the other IDs the dataset lists', async () => {
      await importDataset(testDb.db.client, [{ anilist: '901', mal: '701', kitsu: '56' }]);
      const created = await resolver.resolve({
        externalIds: { anilist: '901' },
        title: makeSourceTitle({ externalIds: { anilist: '901' } }),
      });
      expect(created).toMatchObject({ matchedBy: 'created', created: true });
      expect(await idsOf(created.titleId)).toEqual(['anilist:901', 'kitsu:56', 'mal:701']);

      // So MAL and Kitsu now resolve to it as well.
      const viaMal = await resolver.resolve({ externalIds: { mal: '701' } });
      const viaKitsu = await resolver.resolve({ externalIds: { kitsu: '56' } });
      expect(viaMal.titleId).toBe(created.titleId);
      expect(viaKitsu.titleId).toBe(created.titleId);
    });
  });

  describe('manual overrides win', () => {
    it('an overridden ID resolves to the pinned title whatever the tables say', async () => {
      const wrong = await resolver.resolve({
        externalIds: { anilist: '5' },
        title: makeSourceTitle({ externalIds: { anilist: '5' }, titleRomaji: 'Wrong' }),
      });
      const right = await resolver.resolve({
        externalIds: { mal: '6' },
        title: makeSourceTitle({ externalIds: { mal: '6' }, titleRomaji: 'Right' }),
      });
      await setOverride(testDb.db.client, {
        source: 'anilist',
        externalId: '5',
        titleId: right.titleId,
      });

      const result = await resolver.resolve({ externalIds: { anilist: '5' } });
      expect(result).toMatchObject({ titleId: right.titleId, matchedBy: 'override' });
      expect(result.titleId).not.toBe(wrong.titleId);
      expect(await idsOf(right.titleId)).toEqual(['anilist:5', 'mal:6']);
    });
  });

  describe('relation targets', () => {
    it('resolves a target already known, and creates a placeholder for an unknown one', async () => {
      const known = await resolver.resolve({
        externalIds: { anilist: '20958' },
        title: makeSourceTitle({ externalIds: { anilist: '20958' } }),
      });
      const target = (id: string, title: string | null) => ({
        externalIds: { anilist: id },
        kind: 'tv' as const,
        title,
      });
      expect(await resolver.resolveRelationTarget(target('20958', 'Season 2'))).toMatchObject({
        titleId: known.titleId,
        created: false,
      });

      const placeholder = await resolver.resolveRelationTarget(target('20959', 'Season 3'));
      expect(placeholder.created).toBe(true);
      const row = (
        await testDb.sql.query<Record<string, unknown>>(
          `SELECT title_romaji, status, fetched_at, stale FROM title WHERE id = $1`,
          [placeholder.titleId],
        )
      ).rows[0];
      expect(row).toMatchObject({ title_romaji: 'Season 3', fetched_at: null, stale: true });
    });

    it('cannot make a placeholder out of an edge with no title', async () => {
      await expect(
        resolver.resolveRelationTarget({ externalIds: { anilist: '77' }, kind: null, title: null }),
      ).rejects.toBeInstanceOf(UnresolvableTitleError);
      expect(await count('title')).toBe(0);
    });
  });

  describe('bad input', () => {
    it('refuses when no usable ID is given', async () => {
      await expect(resolver.resolve({ externalIds: {} })).rejects.toBeInstanceOf(
        UnresolvableTitleError,
      );
      await expect(
        resolver.resolve({ externalIds: { anilist: 'abc', mal: "1'; DROP TABLE title;--" } }),
      ).rejects.toBeInstanceOf(UnresolvableTitleError);
    });

    it('refuses to create an unknown title without data, and leaves nothing behind', async () => {
      await expect(resolver.resolve({ externalIds: { anilist: '123' } })).rejects.toBeInstanceOf(
        UnresolvableTitleError,
      );
      expect(await count('title')).toBe(0);
      expect(await count('title_external_id')).toBe(0);
    });

    it('library entries can reference only Akiba IDs: the resolver never returns an external ID', async () => {
      const result = await resolver.resolve({
        externalIds: { anilist: '5' },
        title: makeSourceTitle({ externalIds: { anilist: '5' } }),
      });
      expect(result.titleId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(result.titleId).not.toBe('5');
    });
  });
});
