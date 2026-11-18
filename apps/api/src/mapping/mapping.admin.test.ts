import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, pgFailure, type TestDatabase } from '../testing/database.js';
import {
  insertEntry,
  insertEpisode,
  insertEvent,
  insertNotification,
  insertRun,
  insertTitle,
  insertUser,
} from '../testing/fixtures.js';
import { makeSourceTitle } from '../testing/sources.js';
import { importDataset, parseDataset } from './dataset.js';
import { MergeError, mergeTitles } from './merge.js';
import { OverrideError, removeOverride, setOverride } from './overrides.js';
import { createTitleResolver } from './resolver.js';

/** Doc 11 §3.3, second half: dataset import, overrides and the merge script. Real PostgreSQL. */
describe('mapping administration (doc 05 §5)', () => {
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await createTestDatabase();
  });
  afterAll(async () => {
    await testDb.drop();
  });
  beforeEach(async () => {
    await testDb.reset();
  });

  const db = () => testDb.db.client;
  const sql = () => testDb.sql;
  const one = async <T>(text: string, values: unknown[] = []): Promise<T> =>
    (await sql().query(text, values)).rows[0] as T;
  const count = async (table: string, where = 'true'): Promise<number> =>
    Number((await one<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE ${where}`)).n);
  const idsOf = async (titleId: string): Promise<string[]> =>
    (
      await sql().query<{ k: string }>(
        `SELECT source || ':' || external_id AS k FROM title_external_id WHERE title_id = $1 ORDER BY 1`,
        [titleId],
      )
    ).rows.map((row) => row.k);
  const titleWithIds = async (ids: Record<string, string>, name = 'T'): Promise<string> => {
    const resolved = await createTitleResolver(db()).resolve({
      externalIds: ids,
      title: makeSourceTitle({ externalIds: ids, titleRomaji: name }),
    });
    return resolved.titleId;
  };

  describe('dataset parsing', () => {
    it('keeps rows with two or more IDs, in numbers or strings, and counts what it skips', () => {
      const parsed = parseDataset([
        { anilist_id: 1, mal_id: 2 },
        { anilist_id: '3', kitsu_id: 4, extra: 'ignored' },
        { anilist_id: 5 }, // one ID maps nothing
        { anilist_id: [6, 7], mal_id: 8 }, // a list is ambiguous
        { anilist_id: 'x', mal_id: 9, kitsu_id: 10 },
        'garbage',
      ]);
      expect(parsed.rows).toEqual([
        { anilist: '1', mal: '2', kitsu: null },
        { anilist: '3', mal: null, kitsu: '4' },
        { anilist: null, mal: '9', kitsu: '10' },
      ]);
      expect(parsed.skipped).toBe(3);
    });

    it('refuses something that is not a list', () => {
      expect(() => parseDataset({ anilist_id: 1 })).toThrow();
    });
  });

  describe('dataset import (FR: cross IDs added, conflicts queued)', () => {
    it('stores new rows and leaves identical ones alone on a re-import', async () => {
      const rows = [
        { anilist: '1', mal: '2', kitsu: null },
        { anilist: '3', mal: '4', kitsu: '5' },
      ];
      expect(await importDataset(db(), rows)).toMatchObject({
        added: 2,
        unchanged: 0,
        conflicts: 0,
      });
      expect(await importDataset(db(), rows)).toMatchObject({
        added: 0,
        unchanged: 2,
        conflicts: 0,
      });
      expect(await count('mapping_dataset_entry')).toBe(2);
    });

    it('enriches a stored row that gains an ID', async () => {
      await importDataset(db(), [{ anilist: '1', mal: '2', kitsu: null }]);
      const summary = await importDataset(db(), [{ anilist: '1', mal: '2', kitsu: '9' }]);
      expect(summary).toMatchObject({ enriched: 1, added: 0 });
      expect(await one('SELECT kitsu_id FROM mapping_dataset_entry')).toEqual({ kitsu_id: '9' });
    });

    it('adds the missing cross-source IDs to a title that already exists', async () => {
      const titleId = await titleWithIds({ anilist: '1' });
      const summary = await importDataset(db(), [{ anilist: '1', mal: '2', kitsu: '3' }]);
      expect(summary.linked).toBe(2);
      expect(await idsOf(titleId)).toEqual(['anilist:1', 'kitsu:3', 'mal:2']);
    });

    it('queues a row that contradicts a stored one, and keeps the stored row', async () => {
      await importDataset(db(), [{ anilist: '1', mal: '2', kitsu: null }]);
      const summary = await importDataset(db(), [{ anilist: '1', mal: '99', kitsu: null }]);
      expect(summary.conflicts).toBe(1);
      expect(await one('SELECT mal_id FROM mapping_dataset_entry')).toEqual({ mal_id: '2' });
      expect(await count('mapping_conflict', `reason LIKE '%disagrees with itself%'`)).toBe(1);
      // Importing it again does not pile up duplicates.
      await importDataset(db(), [{ anilist: '1', mal: '99', kitsu: null }]);
      expect(await count('mapping_conflict')).toBe(1);
    });

    it('queues a row that says two titles Akiba holds apart are one, and changes neither', async () => {
      const a = await titleWithIds({ anilist: '10' }, 'A');
      const b = await titleWithIds({ mal: '20' }, 'B');
      const summary = await importDataset(db(), [{ anilist: '10', mal: '20', kitsu: null }]);
      expect(summary.conflicts).toBe(1);
      expect(await idsOf(a)).toEqual(['anilist:10']);
      expect(await idsOf(b)).toEqual(['mal:20']);
      expect(await count('title')).toBe(2);
    });

    it('a manual override beats the dataset: an ID pinned elsewhere is not moved', async () => {
      const a = await titleWithIds({ anilist: '10' }, 'A');
      const pinned = await titleWithIds({ mal: '20' }, 'Pinned');
      await setOverride(db(), { source: 'mal', externalId: '20', titleId: pinned });

      await importDataset(db(), [{ anilist: '10', mal: '20', kitsu: null }]);
      expect(await idsOf(a)).toEqual(['anilist:10']);
      expect(await idsOf(pinned)).toEqual(['mal:20']);
      expect(await count('mapping_conflict')).toBe(0);
    });

    it('a dataset row with a single ID is refused by the database itself', async () => {
      const failure = await pgFailure(() =>
        sql().query(`INSERT INTO mapping_dataset_entry (anilist_id) VALUES ('1')`),
      );
      expect(failure).toMatchObject({
        code: '23514',
        constraint: 'mapping_dataset_entry_two_ids_check',
      });
    });
  });

  describe('manual overrides', () => {
    it('pins an ID to a title and moves the ID there', async () => {
      const wrong = await titleWithIds({ anilist: '5' }, 'Wrong');
      const right = await titleWithIds({ mal: '6' }, 'Right');
      await setOverride(db(), { source: 'anilist', externalId: '5', titleId: right });
      expect(await idsOf(right)).toEqual(['anilist:5', 'mal:6']);
      expect(await idsOf(wrong)).toEqual([]);
    });

    it('is idempotent and can be removed without moving the ID back', async () => {
      const right = await titleWithIds({ mal: '6' }, 'Right');
      const input = { source: 'anilist' as const, externalId: '5', titleId: right };
      await setOverride(db(), input);
      await setOverride(db(), input);
      expect(await count('mapping_override')).toBe(1);
      expect(await removeOverride(db(), 'anilist', '5')).toBe(true);
      expect(await removeOverride(db(), 'anilist', '5')).toBe(false);
      expect(await idsOf(right)).toEqual(['anilist:5', 'mal:6']);
    });

    it('refuses a title that does not exist, and a title that already has another ID at that source', async () => {
      await expect(
        setOverride(db(), {
          source: 'anilist',
          externalId: '5',
          titleId: '00000000-0000-4000-8000-000000000000',
        }),
      ).rejects.toBeInstanceOf(OverrideError);

      const holder = await titleWithIds({ anilist: '7' }, 'Holder');
      await expect(
        setOverride(db(), { source: 'anilist', externalId: '5', titleId: holder }),
      ).rejects.toThrow(/already has anilist ID 7/);
      expect(await count('mapping_override')).toBe(0);
    });
  });

  describe('merge script (doc 05 §5: repoints entries and events without loss)', () => {
    async function scenario() {
      const keep = await titleWithIds({ anilist: '100', mal: '100' }, 'Keep');
      const dup = await titleWithIds({ anilist: '200', kitsu: '300' }, 'Duplicate');
      const userBoth = await insertUser(sql());
      const userOnlyDup = await insertUser(sql());
      const userOnlyKeep = await insertUser(sql());

      // userBoth has an entry on each title, each with a run and events.
      const keepEntry = await insertEntry(sql(), userBoth, keep, { progress: 3, rating: null });
      const keepRun = await insertRun(sql(), keepEntry, 1);
      await insertEvent(sql(), {
        userId: userBoth,
        entryId: keepEntry,
        titleId: keep,
        runId: keepRun,
      });
      const dupEntry = await insertEntry(sql(), userBoth, dup, { progress: 9, rating: 8 });
      const dupRun = await insertRun(sql(), dupEntry, 1); // open, like the survivor's
      await insertEvent(
        sql(),
        { userId: userBoth, entryId: dupEntry, titleId: dup, runId: dupRun },
        { from: 8, to: 9, run: 1 },
      );
      await insertEvent(
        sql(),
        { userId: userBoth, entryId: dupEntry, titleId: dup, runId: dupRun },
        { from: 7, to: 8, run: 1 },
      );

      const onlyDupEntry = await insertEntry(sql(), userOnlyDup, dup, { progress: 2 });
      await insertEvent(sql(), { userId: userOnlyDup, entryId: onlyDupEntry, titleId: dup });
      const onlyKeepEntry = await insertEntry(sql(), userOnlyKeep, keep, { progress: 1 });
      return {
        keep,
        dup,
        userBoth,
        userOnlyDup,
        userOnlyKeep,
        keepEntry,
        dupEntry,
        onlyDupEntry,
        onlyKeepEntry,
      };
    }

    it('moves every entry and event to the kept title and deletes the duplicate', async () => {
      const s = await scenario();
      const eventsBefore = await count('event');
      const payloads = (
        await sql().query<{ payload: unknown }>(`SELECT payload FROM event ORDER BY payload::text`)
      ).rows;

      const summary = await mergeTitles(db(), s.keep, s.dup);
      expect(summary).toMatchObject({ entriesMoved: 1, entriesCombined: 1, eventsRepointed: 1 });

      expect(await count('title', `id = '${s.dup}'`)).toBe(0);
      // Nothing is lost, and nothing about what happened changed.
      expect(await count('event')).toBe(eventsBefore);
      expect(await count('event', `title_id = '${s.keep}'`)).toBe(eventsBefore);
      expect(
        (
          await sql().query<{ payload: unknown }>(
            `SELECT payload FROM event ORDER BY payload::text`,
          )
        ).rows,
      ).toEqual(payloads);
      // Every entry is on the kept title; the user who had both has ONE entry.
      expect(await count('library_entry', `title_id = '${s.keep}'`)).toBe(3);
      expect(await count('library_entry', `user_id = '${s.userBoth}'`)).toBe(1);
      expect(
        await count('library_entry', `id = '${s.onlyDupEntry}' AND title_id = '${s.keep}'`),
      ).toBe(1);
    });

    it('combines two entries of one user: newer status/progress win, gaps are filled, runs are kept', async () => {
      const s = await scenario();
      // Make the duplicate's entry the more recently updated one.
      await sql().query(
        `UPDATE library_entry SET updated_at = now() + interval '1 hour' WHERE id = $1`,
        [s.dupEntry],
      );
      await mergeTitles(db(), s.keep, s.dup);

      const entry = await one<{ progress: number; rating: number | null }>(
        `SELECT progress, rating FROM library_entry WHERE user_id = $1`,
        [s.userBoth],
      );
      expect(entry).toMatchObject({ progress: 9, rating: 8 }); // the rating came from the other entry

      const runs = (
        await sql().query<{ run_number: number; open: boolean }>(
          `SELECT run_number, finished_at IS NULL AS open FROM viewing_run
           WHERE entry_id = $1 ORDER BY run_number`,
          [s.keepEntry],
        )
      ).rows;
      expect(runs).toEqual([
        { run_number: 1, open: true },
        { run_number: 2, open: false }, // the second open run was closed, never dropped
      ]);
      expect(await count('event', `entry_id = '${s.keepEntry}'`)).toBe(3);
      expect(await count('library_entry', `id = '${s.dupEntry}'`)).toBe(0);
    });

    it("moves the duplicate's IDs when the kept title has none at that source, else pins them with an override", async () => {
      const s = await scenario();
      const summary = await mergeTitles(db(), s.keep, s.dup);
      expect(summary).toMatchObject({ externalIdsMoved: 1, externalIdsOverridden: 1 });
      expect(await idsOf(s.keep)).toEqual(['anilist:100', 'kitsu:300', 'mal:100']);

      // The old AniList ID still resolves to the kept title, with no new conflict.
      const again = await createTitleResolver(db()).resolve({ externalIds: { anilist: '200' } });
      expect(again).toMatchObject({ titleId: s.keep, matchedBy: 'override', conflicts: 0 });
      expect(await count('mapping_conflict')).toBe(0);
    });

    it('moves relations (without self-relations), genres and airing episodes with their notifications', async () => {
      const s = await scenario();
      const other = await insertTitle(sql(), { romaji: 'Other' });
      await sql().query(
        `INSERT INTO title_relation (from_title_id, to_title_id, relation_type) VALUES
           ($1, $3, 'sequel'), ($1, $2, 'alternative'), ($3, $1, 'prequel')`,
        [s.dup, s.keep, other],
      );
      const genre = (
        await sql().query<{ id: string }>(`INSERT INTO genre (name) VALUES ('Action') RETURNING id`)
      ).rows[0]!.id;
      await sql().query(`INSERT INTO title_genre (title_id, genre_id) VALUES ($1, $2)`, [
        s.dup,
        genre,
      ]);

      // Episode 1 exists on both titles; episode 2 only on the duplicate.
      const keepEp1 = await insertEpisode(sql(), s.keep, 1);
      const dupEp1 = await insertEpisode(sql(), s.dup, 1);
      const dupEp2 = await insertEpisode(sql(), s.dup, 2);
      await insertNotification(sql(), s.userBoth, s.keep, keepEp1);
      await insertNotification(sql(), s.userBoth, s.dup, dupEp1); // would collide: dropped
      await insertNotification(sql(), s.userOnlyDup, s.dup, dupEp1); // follows the kept episode
      await insertNotification(sql(), s.userOnlyDup, s.dup, dupEp2);

      await mergeTitles(db(), s.keep, s.dup);

      const relations = (
        await sql().query<{ f: string; t: string; type: string }>(
          `SELECT from_title_id AS f, to_title_id AS t, relation_type AS type FROM title_relation ORDER BY type`,
        )
      ).rows;
      expect(relations).toEqual([
        { f: other, t: s.keep, type: 'prequel' },
        { f: s.keep, t: other, type: 'sequel' },
      ]); // the keep↔dup relation is gone: it would be a title related to itself
      expect(await count('title_genre', `title_id = '${s.keep}'`)).toBe(1);
      expect(await count('airing_episode', `title_id = '${s.keep}'`)).toBe(2);
      expect(await count('notification', `user_id = '${s.userBoth}'`)).toBe(1);
      expect(
        await count('notification', `user_id = '${s.userOnlyDup}' AND title_id = '${s.keep}'`),
      ).toBe(2);
    });

    it('is all-or-nothing: a bad request changes nothing', async () => {
      const s = await scenario();
      const before = await count('event');
      await expect(
        mergeTitles(db(), s.keep, '00000000-0000-4000-8000-000000000000'),
      ).rejects.toBeInstanceOf(MergeError);
      await expect(mergeTitles(db(), s.keep, s.keep)).rejects.toBeInstanceOf(MergeError);
      expect(await count('title')).toBe(2);
      expect(await count('library_entry')).toBe(4);
      expect(await count('event')).toBe(before);
    });

    it('does not weaken the append-only guard: outside a merge, events still cannot be repointed', async () => {
      const s = await scenario();
      const failure = await pgFailure(() =>
        sql().query(`UPDATE event SET title_id = $1 WHERE title_id = $2`, [s.keep, s.dup]),
      );
      expect(failure.code).toBe('AKB01');
    });
  });
});
