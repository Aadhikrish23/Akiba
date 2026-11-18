import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../testing/database.js';
import { insertUser } from '../testing/fixtures.js';
import { CLEANUP_GRACE_MS, purgeExpiredAuthData } from './cleanup.js';

describe('expired authentication data is purged daily (doc 06 §6)', () => {
  let testDb: TestDatabase;
  const NOW = new Date('2026-11-18T12:00:00Z');
  const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
  const DAY = 24 * 60 * 60 * 1000;

  beforeAll(async () => {
    testDb = await createTestDatabase();
  });
  afterAll(async () => {
    await testDb.drop();
  });
  beforeEach(async () => {
    await testDb.reset();
  });

  const refreshToken = async (
    userId: string,
    options: { familyExpiresAt: Date; revoked?: boolean; familyId?: string },
  ): Promise<string> =>
    (
      await testDb.sql.query<{ id: string }>(
        `INSERT INTO refresh_token (user_id, family_id, token_hash, expires_at, family_expires_at, revoked_at)
         VALUES ($1, $2, $3, $4, $4, $5) RETURNING id`,
        [
          userId,
          options.familyId ?? randomUUID(),
          randomUUID(),
          options.familyExpiresAt,
          options.revoked === true ? NOW : null,
        ],
      )
    ).rows[0]!.id;

  const oneTimeToken = async (
    userId: string,
    options: { expiresAt: Date; usedAt?: Date },
  ): Promise<void> => {
    await testDb.sql.query(
      `INSERT INTO one_time_token (user_id, purpose, token_hash, sent_to, expires_at, used_at)
       VALUES ($1, 'verify_email', $2, 'a@example.test', $3, $4)`,
      [userId, randomUUID(), options.expiresAt, options.usedAt ?? null],
    );
  };

  const count = async (table: string): Promise<number> =>
    Number(
      (await testDb.sql.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n,
    );

  it('deletes refresh tokens only once their whole session is past its deadline (plus a day)', async () => {
    const user = await insertUser(testDb.sql);
    await refreshToken(user, { familyExpiresAt: ago(2 * DAY) }); // long over: purged
    await refreshToken(user, { familyExpiresAt: ago(CLEANUP_GRACE_MS - 1000) }); // within the grace
    await refreshToken(user, { familyExpiresAt: new Date(NOW.getTime() + DAY) }); // alive

    const summary = await purgeExpiredAuthData(testDb.db.client, NOW);
    expect(summary.refreshTokens).toBe(1);
    expect(await count('refresh_token')).toBe(2);
  });

  it('keeps a revoked token while its session lasts: presenting it again is how theft is detected', async () => {
    const user = await insertUser(testDb.sql);
    await refreshToken(user, {
      familyExpiresAt: new Date(NOW.getTime() + 10 * DAY),
      revoked: true,
    });
    await purgeExpiredAuthData(testDb.db.client, NOW);
    expect(await count('refresh_token')).toBe(1);
  });

  it('removes a whole expired family, including tokens that point at each other', async () => {
    const user = await insertUser(testDb.sql);
    const family = randomUUID();
    const first = await refreshToken(user, {
      familyExpiresAt: ago(3 * DAY),
      familyId: family,
      revoked: true,
    });
    const second = await refreshToken(user, { familyExpiresAt: ago(3 * DAY), familyId: family });
    await testDb.sql.query(`UPDATE refresh_token SET replaced_by_id = $1 WHERE id = $2`, [
      second,
      first,
    ]);

    const summary = await purgeExpiredAuthData(testDb.db.client, NOW);
    expect(summary.refreshTokens).toBe(2);
    expect(await count('refresh_token')).toBe(0);
  });

  it('deletes one-time tokens a day after they expired or were used, not before', async () => {
    const user = await insertUser(testDb.sql);
    await oneTimeToken(user, { expiresAt: ago(2 * DAY) }); // expired long ago
    await oneTimeToken(user, { expiresAt: new Date(NOW.getTime() + DAY), usedAt: ago(2 * DAY) }); // used long ago
    await oneTimeToken(user, { expiresAt: ago(60 * 60 * 1000) }); // expired an hour ago: kept
    await oneTimeToken(user, { expiresAt: new Date(NOW.getTime() + DAY) }); // live

    const summary = await purgeExpiredAuthData(testDb.db.client, NOW);
    expect(summary.oneTimeTokens).toBe(2);
    expect(await count('one_time_token')).toBe(2);
  });

  it('is idempotent and touches nothing else', async () => {
    const user = await insertUser(testDb.sql);
    await refreshToken(user, { familyExpiresAt: ago(5 * DAY) });
    await purgeExpiredAuthData(testDb.db.client, NOW);
    expect(await purgeExpiredAuthData(testDb.db.client, NOW)).toEqual({
      refreshTokens: 0,
      oneTimeTokens: 0,
    });
    expect(await count('"user"')).toBe(1);
  });
});
