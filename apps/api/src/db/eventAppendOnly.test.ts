import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, pgFailure, type TestDatabase } from '../testing/database.js';
import {
  insertEntry,
  insertEvent,
  insertRun,
  insertTitle,
  insertUser,
} from '../testing/fixtures.js';

/** SQLSTATE raised by the `event_append_only_guard` trigger. */
const APPEND_ONLY = 'AKB01';

let testDb: TestDatabase;
let userId: string;
let titleId: string;
let entryId: string;
let runId: string;
let eventId: string;

/** Run statements in one transaction after opting in to a maintenance mode. */
async function inMaintenance<T>(
  mode: string,
  run: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await testDb.sql.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('akiba.event_maintenance', $1, true)`, [mode]);
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function eventCount(): Promise<number> {
  const result = await testDb.sql.query<{ n: number }>('SELECT count(*)::int AS n FROM event');
  return result.rows[0]?.n ?? -1;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
});

afterAll(async () => {
  await testDb.drop();
});

beforeEach(async () => {
  await testDb.reset();
  userId = await insertUser(testDb.sql);
  titleId = await insertTitle(testDb.sql);
  entryId = await insertEntry(testDb.sql, userId, titleId);
  runId = await insertRun(testDb.sql, entryId, 1);
  eventId = await insertEvent(testDb.sql, { userId, entryId, titleId, runId });
});

describe('FR-REM-007 event is append-only at the database', () => {
  it('FR-REM-007 accepts inserts (a correction is a new event)', async () => {
    await insertEvent(testDb.sql, { userId, entryId, titleId, runId }, { from: 1, to: 0, run: 1 });
    expect(await eventCount()).toBe(2);
  });

  it.each([
    ['payload', `UPDATE event SET payload = '{"from":0,"to":99}' WHERE id = $1`],
    ['type', `UPDATE event SET type = 'rated' WHERE id = $1`],
    ['occurred_at', `UPDATE event SET occurred_at = now() - interval '1 day' WHERE id = $1`],
    ['title_id', `UPDATE event SET title_id = title_id WHERE id = $1`],
  ])('FR-REM-007 rejects UPDATE of %s', async (_column, statement) => {
    const failure = await pgFailure(() => testDb.sql.query(statement, [eventId]));

    expect(failure.code).toBe(APPEND_ONLY);
    expect(failure.message).toBe('event is append-only: UPDATE is not allowed');
  });

  it('FR-REM-007 rejects DELETE and leaves the row in place', async () => {
    const failure = await pgFailure(() =>
      testDb.sql.query('DELETE FROM event WHERE id = $1', [eventId]),
    );

    expect(failure.code).toBe(APPEND_ONLY);
    expect(failure.message).toBe('event is append-only: DELETE is not allowed');
    expect(await eventCount()).toBe(1);
  });

  it('FR-REM-007 rejects TRUNCATE, also when it arrives through CASCADE from another table', async () => {
    const direct = await pgFailure(() => testDb.sql.query('TRUNCATE event'));
    expect(direct.code).toBe(APPEND_ONLY);

    const cascaded = await pgFailure(() => testDb.sql.query('TRUNCATE "user" CASCADE'));
    expect(cascaded.code).toBe(APPEND_ONLY);
    expect(await eventCount()).toBe(1);
  });

  it('FR-REM-007 rejects UPDATE and DELETE through the Prisma client', async () => {
    const { client } = testDb.db;

    await expect(
      client.event.update({ where: { id: eventId }, data: { payload: {} } }),
    ).rejects.toThrow(/event is append-only/);
    await expect(client.event.delete({ where: { id: eventId } })).rejects.toThrow(
      /event is append-only/,
    );
    await expect(client.event.deleteMany()).rejects.toThrow(/event is append-only/);
    expect(await eventCount()).toBe(1);
  });

  it('FR-REM-007 blocks hard-deleting an entry, a run or a user that has events', async () => {
    for (const statement of [
      'DELETE FROM library_entry',
      'DELETE FROM viewing_run',
      'DELETE FROM "user"',
    ]) {
      const failure = await pgFailure(() => testDb.sql.query(statement));
      expect(failure.code, statement).toBe(APPEND_ONLY);
    }
    expect(await eventCount()).toBe(1);
    const users = await testDb.sql.query('SELECT 1 FROM "user"');
    expect(users.rowCount).toBe(1);
  });

  it('FR-REM-007 a title that has events cannot be deleted even in purge mode', async () => {
    const failure = await pgFailure(() =>
      inMaintenance('purge', (client) => client.query('DELETE FROM title')),
    );
    expect(failure.code).toBe('23503');
  });

  it('FR-REM-007 ignores unknown maintenance modes', async () => {
    for (const mode of ['', 'on', 'true', 'PURGE', 'merge']) {
      const failure = await pgFailure(() =>
        inMaintenance(mode, (client) => client.query('DELETE FROM event')),
      );
      expect(failure.code, `mode "${mode}"`).toBe(APPEND_ONLY);
    }
  });
});

describe('FR-ACCT-002 account purge may delete events (documented exception)', () => {
  it('FR-ACCT-002 deleting the user in purge mode removes all of their data, and only theirs', async () => {
    const otherUser = await insertUser(testDb.sql);
    const otherEntry = await insertEntry(testDb.sql, otherUser, titleId);
    await insertEvent(testDb.sql, { userId: otherUser, entryId: otherEntry, titleId });

    await inMaintenance('purge', (client) =>
      client.query('DELETE FROM "user" WHERE id = $1', [userId]),
    );

    const remaining = await testDb.sql.query<{ table: string; n: number }>(
      `SELECT 'user' AS table, count(*)::int AS n FROM "user"
       UNION ALL SELECT 'library_entry', count(*)::int FROM library_entry
       UNION ALL SELECT 'viewing_run', count(*)::int FROM viewing_run
       UNION ALL SELECT 'event', count(*)::int FROM event
       UNION ALL SELECT 'title', count(*)::int FROM title`,
    );
    expect(Object.fromEntries(remaining.rows.map((row) => [row.table, row.n]))).toEqual({
      user: 1,
      library_entry: 1,
      viewing_run: 0,
      event: 1,
      title: 1,
    });
    const survivor = await testDb.sql.query<{ user_id: string }>('SELECT user_id FROM event');
    expect(survivor.rows[0]?.user_id).toBe(otherUser);
  });

  it('FR-ACCT-002 purge also removes tokens, OAuth links, notifications and the share link', async () => {
    await testDb.sql.query(
      `INSERT INTO refresh_token (user_id, family_id, token_hash, expires_at)
       VALUES ($1, gen_random_uuid(), 'h1', now() + interval '1 day')`,
      [userId],
    );
    await testDb.sql.query(
      `INSERT INTO refresh_token (user_id, family_id, token_hash, expires_at, replaced_by_id)
       SELECT user_id, family_id, 'h0', expires_at, id FROM refresh_token`,
    );
    await testDb.sql.query(
      `INSERT INTO one_time_token (user_id, purpose, token_hash, expires_at)
       VALUES ($1, 'reset_password', 'h2', now() + interval '1 hour')`,
      [userId],
    );
    await testDb.sql.query(
      `INSERT INTO oauth_account (user_id, provider, provider_user_id) VALUES ($1, 'apple', 's')`,
      [userId],
    );
    await testDb.sql.query(
      `WITH episode AS (
         INSERT INTO airing_episode (title_id, episode_number, airs_at, source)
         VALUES ($2, 1, now(), 'anilist') RETURNING id)
       INSERT INTO notification (user_id, kind, title_id, episode_id)
       SELECT $1, 'episode_aired', $2, id FROM episode`,
      [userId, titleId],
    );
    await testDb.sql.query(
      `INSERT INTO share_link (user_id, token_hash, scope) VALUES ($1, 'h3', '{}')`,
      [userId],
    );

    await inMaintenance('purge', (client) => client.query('DELETE FROM "user"'));

    for (const table of [
      'user',
      'refresh_token',
      'one_time_token',
      'oauth_account',
      'notification',
      'share_link',
      'library_entry',
      'viewing_run',
      'event',
    ]) {
      const rows = await testDb.sql.query(`SELECT 1 FROM "${table}"`);
      expect(rows.rowCount, table).toBe(0);
    }
    // Catalog data is not user-owned and stays.
    expect((await testDb.sql.query('SELECT 1 FROM airing_episode')).rowCount).toBe(1);
  });

  it('FR-ACCT-002 purge mode ends with its transaction and still forbids UPDATE', async () => {
    const duringPurge = await pgFailure(() =>
      inMaintenance('purge', (client) =>
        client.query(`UPDATE event SET payload = '{}' WHERE id = $1`, [eventId]),
      ),
    );
    expect(duringPurge.code).toBe(APPEND_ONLY);

    // One connection, so the next statement provably reuses the session that was in purge mode.
    const client = await testDb.sql.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('akiba.event_maintenance', 'purge', true)`);
      await client.query('COMMIT');
      const afterCommit = await pgFailure(() => client.query('DELETE FROM event'));
      expect(afterCommit.code).toBe(APPEND_ONLY);
    } finally {
      client.release();
    }
    expect(await eventCount()).toBe(1);
  });

  it('FR-ACCT-002 purge works through the Prisma client in an interactive transaction', async () => {
    await testDb.db.client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('akiba.event_maintenance', 'purge', true)`;
      await tx.user.delete({ where: { id: userId } });
    });

    expect(await eventCount()).toBe(0);
    // The setting did not leak to the pooled connections.
    const other = await insertUser(testDb.sql);
    const entry = await insertEntry(testDb.sql, other, titleId);
    const kept = await insertEvent(testDb.sql, { userId: other, entryId: entry, titleId });
    await expect(testDb.db.client.event.delete({ where: { id: kept } })).rejects.toThrow(
      /event is append-only/,
    );
  });
});

describe('title merge may repoint events (documented exception, doc 05 §5)', () => {
  it('merge mode allows repointing title_id, entry_id and run_id only', async () => {
    const survivingTitle = await insertTitle(testDb.sql, { romaji: 'Surviving title' });
    const survivingEntry = await insertEntry(testDb.sql, userId, survivingTitle);

    await inMaintenance('merge', (client) =>
      client.query('UPDATE event SET title_id = $1, entry_id = $2, run_id = NULL WHERE id = $3', [
        survivingTitle,
        survivingEntry,
        eventId,
      ]),
    );

    const row = await testDb.sql.query<{ title_id: string; entry_id: string; payload: unknown }>(
      'SELECT title_id, entry_id, payload FROM event WHERE id = $1',
      [eventId],
    );
    expect(row.rows[0]).toEqual({
      title_id: survivingTitle,
      entry_id: survivingEntry,
      payload: { from: 0, to: 1, run: 1 },
    });
  });

  it.each([
    ['payload', `UPDATE event SET payload = '{}'`],
    ['type', `UPDATE event SET type = 'rated'`],
    ['user_id', `UPDATE event SET user_id = (SELECT id FROM "user" WHERE id <> user_id LIMIT 1)`],
    ['occurred_at', `UPDATE event SET occurred_at = occurred_at - interval '1 hour'`],
    ['created_at', `UPDATE event SET created_at = created_at - interval '1 hour'`],
  ])('merge mode still rejects UPDATE of %s', async (_column, statement) => {
    await insertUser(testDb.sql);
    const failure = await pgFailure(() =>
      inMaintenance('merge', (client) => client.query(statement)),
    );
    expect(failure.code).toBe(APPEND_ONLY);
  });

  it('merge mode does not allow DELETE or TRUNCATE', async () => {
    for (const statement of ['DELETE FROM event', 'TRUNCATE event']) {
      const failure = await pgFailure(() =>
        inMaintenance('merge', (client) => client.query(statement)),
      );
      expect(failure.code, statement).toBe(APPEND_ONLY);
    }
  });
});
