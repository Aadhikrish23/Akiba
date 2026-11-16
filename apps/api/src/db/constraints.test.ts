import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, pgFailure, type TestDatabase } from '../testing/database.js';
import {
  insertEntry,
  insertEpisode,
  insertNotification,
  insertRun,
  insertShareLink,
  insertTitle,
  insertUser,
} from '../testing/fixtures.js';
import { Prisma } from './index.js';

// PostgreSQL SQLSTATEs.
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';
const NOT_NULL_VIOLATION = '23502';

let testDb: TestDatabase;
let userId: string;
let titleId: string;

beforeAll(async () => {
  testDb = await createTestDatabase();
});

afterAll(async () => {
  await testDb.drop();
});

beforeEach(async () => {
  await testDb.reset();
  userId = await insertUser(testDb.sql);
  titleId = await insertTitle(testDb.sql, { episodesTotal: 12 });
});

describe('library_entry constraints (doc 06 §4)', () => {
  it('FR-LIB-006 rejects a second entry for the same user and title', async () => {
    await insertEntry(testDb.sql, userId, titleId);

    const failure = await pgFailure(() => insertEntry(testDb.sql, userId, titleId));

    expect(failure).toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint: 'library_entry_user_id_title_id_key',
    });
    const count = await testDb.sql.query('SELECT 1 FROM library_entry');
    expect(count.rowCount).toBe(1);
  });

  it('FR-LIB-006 still rejects a duplicate when the first entry was soft-removed', async () => {
    const entryId = await insertEntry(testDb.sql, userId, titleId);
    await testDb.sql.query('UPDATE library_entry SET removed_at = now() WHERE id = $1', [entryId]);

    const failure = await pgFailure(() => insertEntry(testDb.sql, userId, titleId));

    expect(failure.constraint).toBe('library_entry_user_id_title_id_key');
  });

  it('FR-LIB-006 lets another user, and the same user with another title, add an entry', async () => {
    await insertEntry(testDb.sql, userId, titleId);
    const otherUser = await insertUser(testDb.sql);
    const otherTitle = await insertTitle(testDb.sql);

    await expect(insertEntry(testDb.sql, otherUser, titleId)).resolves.toBeTypeOf('string');
    await expect(insertEntry(testDb.sql, userId, otherTitle)).resolves.toBeTypeOf('string');
  });

  it('FR-LIB-006 surfaces through the Prisma client as P2002', async () => {
    const data = { userId, titleId, status: 'planned' } as const;
    await testDb.db.client.libraryEntry.create({ data });

    const error: unknown = await testDb.db.client.libraryEntry
      .create({ data })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
  });

  it('FR-TRK-001 rejects negative progress on insert and on update', async () => {
    const onInsert = await pgFailure(() =>
      insertEntry(testDb.sql, userId, titleId, { progress: -1 }),
    );
    expect(onInsert).toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'library_entry_progress_check',
    });

    const entryId = await insertEntry(testDb.sql, userId, titleId, { progress: 0 });
    const onUpdate = await pgFailure(() =>
      testDb.sql.query('UPDATE library_entry SET progress = progress - 1 WHERE id = $1', [entryId]),
    );
    expect(onUpdate.constraint).toBe('library_entry_progress_check');
  });

  it('FR-TRK-001 accepts progress 0 and positive progress', async () => {
    const entryId = await insertEntry(testDb.sql, userId, titleId, { progress: 0 });
    await testDb.sql.query('UPDATE library_entry SET progress = 12 WHERE id = $1', [entryId]);
    const row = await testDb.sql.query<{ progress: number }>('SELECT progress FROM library_entry');
    expect(row.rows[0]?.progress).toBe(12);
  });

  it('FR-TRK-007 rejects progress above the episode-total override stored on the entry', async () => {
    const failure = await pgFailure(() =>
      insertEntry(testDb.sql, userId, titleId, { progress: 14, override: 13 }),
    );
    expect(failure).toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'library_entry_progress_within_override_check',
    });

    // Lowering the override below the current progress is rejected as well.
    const entryId = await insertEntry(testDb.sql, userId, titleId, { progress: 13, override: 13 });
    const lowered = await pgFailure(() =>
      testDb.sql.query('UPDATE library_entry SET episodes_total_override = 10 WHERE id = $1', [
        entryId,
      ]),
    );
    expect(lowered.constraint).toBe('library_entry_progress_within_override_check');
  });

  it('FR-TRK-007 does not bound progress in the database when no override is stored', async () => {
    // The title total (12) lives on another table; that bound is the service's job (T16).
    await expect(insertEntry(testDb.sql, userId, titleId, { progress: 500 })).resolves.toBeTypeOf(
      'string',
    );
  });

  it('FR-TRK-005 rejects an episode-total override below 1', async () => {
    for (const override of [0, -3]) {
      const failure = await pgFailure(() => insertEntry(testDb.sql, userId, titleId, { override }));
      expect(failure).toMatchObject({
        code: CHECK_VIOLATION,
        constraint: 'library_entry_episodes_total_override_check',
      });
    }
    await expect(insertEntry(testDb.sql, userId, titleId, { override: 1 })).resolves.toBeTypeOf(
      'string',
    );
  });

  it.each([0, 11, -1])('FR-REM-001 rejects rating %i', async (rating) => {
    const failure = await pgFailure(() => insertEntry(testDb.sql, userId, titleId, { rating }));
    expect(failure).toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'library_entry_rating_check',
    });
  });

  it.each([1, 10, null])('FR-REM-001 accepts rating %s', async (rating) => {
    await expect(insertEntry(testDb.sql, userId, titleId, { rating })).resolves.toBeTypeOf(
      'string',
    );
  });

  it('a check violation surfaces through the Prisma client as an error, not a silent no-op', async () => {
    const attempt = testDb.db.client.libraryEntry.create({
      data: { userId, titleId, status: 'watching', progress: -1 },
    });
    await expect(attempt).rejects.toThrow(/library_entry_progress_check/);
  });

  it('an entry must reference an existing title (doc 06 §4.7) and user', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    expect(await pgFailure(() => insertEntry(testDb.sql, userId, missing))).toMatchObject({
      code: FOREIGN_KEY_VIOLATION,
      constraint: 'library_entry_title_id_fkey',
    });
    expect(await pgFailure(() => insertEntry(testDb.sql, missing, titleId))).toMatchObject({
      code: FOREIGN_KEY_VIOLATION,
      constraint: 'library_entry_user_id_fkey',
    });
  });

  it('a title that is in a library cannot be deleted', async () => {
    await insertEntry(testDb.sql, userId, titleId);
    const failure = await pgFailure(() =>
      testDb.sql.query('DELETE FROM title WHERE id = $1', [titleId]),
    );
    expect(failure.constraint).toBe('library_entry_title_id_fkey');
  });
});

describe('viewing_run constraints (doc 06 §4.3)', () => {
  let entryId: string;

  beforeEach(async () => {
    entryId = await insertEntry(testDb.sql, userId, titleId);
  });

  it('FR-REM-004 rejects a second open run for the same entry', async () => {
    await insertRun(testDb.sql, entryId, 1);

    const failure = await pgFailure(() => insertRun(testDb.sql, entryId, 2));

    expect(failure).toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint: 'viewing_run_one_open_per_entry_key',
    });
  });

  it('FR-REM-004 allows a new run once the previous one is finished, keeping both', async () => {
    await insertRun(testDb.sql, entryId, 1, { finished: true, progressAtEnd: 12 });
    await insertRun(testDb.sql, entryId, 2, { finished: true, progressAtEnd: 12 });
    await insertRun(testDb.sql, entryId, 3);

    const runs = await testDb.sql.query<{ run_number: number; open: boolean }>(
      'SELECT run_number, finished_at IS NULL AS open FROM viewing_run ORDER BY run_number',
    );
    expect(runs.rows).toEqual([
      { run_number: 1, open: false },
      { run_number: 2, open: false },
      { run_number: 3, open: true },
    ]);
  });

  it('FR-REM-004 rejects reopening a finished run while another run is open', async () => {
    const first = await insertRun(testDb.sql, entryId, 1, { finished: true });
    await insertRun(testDb.sql, entryId, 2);

    const failure = await pgFailure(() =>
      testDb.sql.query('UPDATE viewing_run SET finished_at = NULL WHERE id = $1', [first]),
    );

    expect(failure.constraint).toBe('viewing_run_one_open_per_entry_key');
  });

  it('FR-REM-004 allows one open run on each of two entries', async () => {
    const otherEntry = await insertEntry(testDb.sql, userId, await insertTitle(testDb.sql));
    await insertRun(testDb.sql, entryId, 1);
    await expect(insertRun(testDb.sql, otherEntry, 1)).resolves.toBeTypeOf('string');
  });

  it('FR-REM-004 rejects a duplicate run number within an entry', async () => {
    await insertRun(testDb.sql, entryId, 1, { finished: true });
    const failure = await pgFailure(() => insertRun(testDb.sql, entryId, 1, { finished: true }));
    expect(failure).toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint: 'viewing_run_entry_id_run_number_key',
    });
  });

  it('rejects run number 0 and negative run numbers', async () => {
    for (const runNumber of [0, -1]) {
      const failure = await pgFailure(() => insertRun(testDb.sql, entryId, runNumber));
      expect(failure).toMatchObject({
        code: CHECK_VIOLATION,
        constraint: 'viewing_run_run_number_check',
      });
    }
  });

  it.each([0, 11])('rejects run rating %i', async (rating) => {
    const failure = await pgFailure(() => insertRun(testDb.sql, entryId, 1, { rating }));
    expect(failure.constraint).toBe('viewing_run_rating_check');
  });

  it('rejects a negative progress_at_end and a run that finishes before it starts', async () => {
    const negative = await pgFailure(() =>
      insertRun(testDb.sql, entryId, 1, { progressAtEnd: -1 }),
    );
    expect(negative.constraint).toBe('viewing_run_progress_at_end_check');

    const backwards = await pgFailure(() =>
      testDb.sql.query(
        `INSERT INTO viewing_run (entry_id, run_number, started_at, finished_at)
         VALUES ($1, 1, now(), now() - interval '1 second')`,
        [entryId],
      ),
    );
    expect(backwards.constraint).toBe('viewing_run_finished_after_started_check');
  });
});

describe('notification and share_link constraints (doc 06 §4.4, §4.5)', () => {
  it('FR-NOTE-002 rejects a second notification for the same user and episode', async () => {
    const episodeId = await insertEpisode(testDb.sql, titleId, 1);
    await insertNotification(testDb.sql, userId, titleId, episodeId);

    const failure = await pgFailure(() =>
      insertNotification(testDb.sql, userId, titleId, episodeId),
    );

    expect(failure).toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint: 'notification_user_id_episode_id_key',
    });
  });

  it('FR-NOTE-002 makes fan-out idempotent with ON CONFLICT DO NOTHING', async () => {
    const episodeId = await insertEpisode(testDb.sql, titleId, 1);
    const fanOut = () =>
      testDb.sql.query(
        `INSERT INTO notification (user_id, kind, title_id, episode_id)
         VALUES ($1, 'episode_aired', $2, $3) ON CONFLICT (user_id, episode_id) DO NOTHING`,
        [userId, titleId, episodeId],
      );

    expect((await fanOut()).rowCount).toBe(1);
    expect((await fanOut()).rowCount).toBe(0);
  });

  it('FR-NOTE-002 allows the same episode for another user and another episode for the same user', async () => {
    const first = await insertEpisode(testDb.sql, titleId, 1);
    const second = await insertEpisode(testDb.sql, titleId, 2);
    const otherUser = await insertUser(testDb.sql);
    await insertNotification(testDb.sql, userId, titleId, first);

    await expect(insertNotification(testDb.sql, otherUser, titleId, first)).resolves.toBeTypeOf(
      'string',
    );
    await expect(insertNotification(testDb.sql, userId, titleId, second)).resolves.toBeTypeOf(
      'string',
    );
  });

  it('FR-SHARE-001 rejects a second share link for the same user, even after revocation', async () => {
    const linkId = await insertShareLink(testDb.sql, userId);
    expect(await pgFailure(() => insertShareLink(testDb.sql, userId))).toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint: 'share_link_user_id_key',
    });

    await testDb.sql.query('UPDATE share_link SET revoked_at = now() WHERE id = $1', [linkId]);
    expect((await pgFailure(() => insertShareLink(testDb.sql, userId))).constraint).toBe(
      'share_link_user_id_key',
    );
  });

  it('FR-SHARE-001 rejects two share links with the same token hash', async () => {
    const otherUser = await insertUser(testDb.sql);
    const insert = (owner: string) =>
      testDb.sql.query(
        `INSERT INTO share_link (user_id, token_hash, scope) VALUES ($1, 'same-hash', '{}')`,
        [owner],
      );
    await insert(userId);
    expect((await pgFailure(() => insert(otherUser))).constraint).toBe('share_link_token_hash_key');
  });
});

describe('identity constraints (doc 06 §2)', () => {
  it('FR-AUTH-001 rejects a second account whose email differs only in letter case', async () => {
    await insertUser(testDb.sql, 'Mixed.Case@Example.test');

    const failure = await pgFailure(() => insertUser(testDb.sql, 'mixed.case@example.TEST'));

    expect(failure).toMatchObject({ code: UNIQUE_VIOLATION, constraint: 'user_email_key' });
  });

  it('FR-AUTH-001 finds a user by email regardless of case, and keeps the case as entered', async () => {
    await insertUser(testDb.sql, 'Mixed.Case@Example.test');

    const found = await testDb.db.client.user.findUnique({
      where: { email: 'MIXED.CASE@EXAMPLE.TEST' },
    });

    expect(found?.email).toBe('Mixed.Case@Example.test');
  });

  it('applies the documented defaults to a new user', async () => {
    const user = await testDb.db.client.user.create({ data: { email: 'defaults@example.test' } });
    expect(user).toMatchObject({
      titleLanguage: 'romaji',
      timeZone: 'UTC',
      libraryView: 'grid',
      alertsEnabled: true,
      passwordHash: null,
      emailVerifiedAt: null,
      deletedAt: null,
      purgeAfter: null,
    });
    expect(user.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('FR-AUTH-002 rejects linking the same provider identity twice', async () => {
    const otherUser = await insertUser(testDb.sql);
    const link = (owner: string) =>
      testDb.sql.query(
        `INSERT INTO oauth_account (user_id, provider, provider_user_id) VALUES ($1, 'google', 'sub-1')`,
        [owner],
      );
    await link(userId);
    expect(await pgFailure(() => link(otherUser))).toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint: 'oauth_account_provider_provider_user_id_key',
    });
  });

  it('rejects duplicate refresh-token and one-time-token hashes', async () => {
    const refresh = () =>
      testDb.sql.query(
        `INSERT INTO refresh_token (user_id, family_id, token_hash, expires_at, family_expires_at)
         VALUES ($1, gen_random_uuid(), 'hash-1', now() + interval '14 days', now() + interval '30 days')`,
        [userId],
      );
    await refresh();
    expect((await pgFailure(refresh)).constraint).toBe('refresh_token_token_hash_key');

    // S-AUTH-6: a token may not outlive the absolute deadline of its family.
    const outlives = () =>
      testDb.sql.query(
        `INSERT INTO refresh_token (user_id, family_id, token_hash, expires_at, family_expires_at)
         VALUES ($1, gen_random_uuid(), 'hash-2', now() + interval '31 days', now() + interval '30 days')`,
        [userId],
      );
    expect(await pgFailure(outlives)).toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'refresh_token_expiry_within_family_check',
    });

    const oneTime = () =>
      testDb.sql.query(
        `INSERT INTO one_time_token (user_id, purpose, token_hash, sent_to, expires_at)
         VALUES ($1, 'verify_email', 'hash-2', 'a@example.test', now() + interval '1 day')`,
        [userId],
      );
    await oneTime();
    expect((await pgFailure(oneTime)).constraint).toBe('one_time_token_token_hash_key');
  });

  it('rejects values outside an enum', async () => {
    const failure = await pgFailure(() =>
      testDb.sql.query(`UPDATE "user" SET library_view = 'carousel' WHERE id = $1`, [userId]),
    );
    expect(failure.code).toBe('22P02'); // invalid_text_representation
  });
});

describe('catalog constraints (doc 06 §2, §5)', () => {
  it('rejects a second title_external_id with the same source and external ID', async () => {
    const otherTitle = await insertTitle(testDb.sql);
    const map = (title: string, source: string, externalId: string) =>
      testDb.sql.query(
        `INSERT INTO title_external_id (title_id, source, external_id) VALUES ($1, $2, $3)`,
        [title, source, externalId],
      );
    await map(titleId, 'anilist', '1');

    expect(await pgFailure(() => map(otherTitle, 'anilist', '1'))).toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint: 'title_external_id_source_external_id_key',
    });
    // The same number from another source is a different ID.
    await expect(map(titleId, 'mal', '1')).resolves.toBeDefined();
  });

  it('rejects a duplicate airing episode number within a title', async () => {
    await insertEpisode(testDb.sql, titleId, 1);
    expect(await pgFailure(() => insertEpisode(testDb.sql, titleId, 1))).toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint: 'airing_episode_title_id_episode_number_key',
    });
    expect((await pgFailure(() => insertEpisode(testDb.sql, titleId, 0))).constraint).toBe(
      'airing_episode_episode_number_check',
    );
  });

  it('rejects a duplicate relation, a self-relation and a duplicate manual override', async () => {
    const otherTitle = await insertTitle(testDb.sql);
    const relate = (from: string, to: string) =>
      testDb.sql.query(
        `INSERT INTO title_relation (from_title_id, to_title_id, relation_type)
         VALUES ($1, $2, 'sequel')`,
        [from, to],
      );
    await relate(titleId, otherTitle);
    expect((await pgFailure(() => relate(titleId, otherTitle))).constraint).toBe(
      'title_relation_pkey',
    );
    expect((await pgFailure(() => relate(titleId, titleId))).constraint).toBe(
      'title_relation_not_self_check',
    );

    const override = () =>
      testDb.sql.query(
        `INSERT INTO mapping_override (source, external_id, title_id) VALUES ('mal', '7', $1)`,
        [titleId],
      );
    await override();
    expect((await pgFailure(override)).constraint).toBe('mapping_override_pkey');
  });

  it('rejects a title without any name and a title with an episode total below 1', async () => {
    expect(await pgFailure(() => insertTitle(testDb.sql, { romaji: null }))).toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'title_has_a_name_check',
    });
    expect((await pgFailure(() => insertTitle(testDb.sql, { episodesTotal: 0 }))).constraint).toBe(
      'title_episodes_total_check',
    );
  });

  it('rejects a duplicate genre name and a title without kind', async () => {
    await testDb.sql.query(`INSERT INTO genre (name) VALUES ('Action')`);
    expect(
      (await pgFailure(() => testDb.sql.query(`INSERT INTO genre (name) VALUES ('Action')`)))
        .constraint,
    ).toBe('genre_name_key');

    const failure = await pgFailure(() =>
      testDb.sql.query(`INSERT INTO title (status, title_romaji) VALUES ('finished', 'x')`),
    );
    expect(failure.code).toBe(NOT_NULL_VIOLATION);
  });
});
