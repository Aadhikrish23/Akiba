import { randomUUID } from 'node:crypto';
import { importJWK, SignJWT } from 'jose';
import request from 'supertest';
import { createApp } from '../../app.js';
import { createLogger } from '../../lib/logger.js';
import { MemoryRateLimitStore } from '../../middleware/rateLimit.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildAuthTestApp,
  cookieHeader,
  DAY,
  getMe,
  loginMobile,
  loginWeb,
  MINUTE,
  MOBILE_HEADERS,
  newCredentials,
  refreshCookieValue,
  refreshMobile,
  refreshWeb,
  register,
  SECOND,
  setCookieLines,
  WEB_HEADERS,
  type AuthTestApp,
  type Credentials,
  type TestSession,
} from '../../testing/auth.js';
import { createTestDatabase, type TestDatabase } from '../../testing/database.js';
import { testConfig } from '../../testing/harness.js';
import { generateSigningJwk } from './accessTokens.js';
import { hashRefreshToken } from './refreshTokens.js';

const PROBLEM_JSON = /^application\/problem\+json/;

interface TokenRow {
  id: string;
  user_id: string;
  family_id: string;
  token_hash: string;
  revoked_at: Date | null;
  replaced_by_id: string | null;
  expires_at: Date;
  family_expires_at: Date;
}

describe('auth over HTTP: sessions, refresh rotation, logout', () => {
  let testDb: TestDatabase;
  let t: AuthTestApp;
  let alice: Credentials;

  beforeAll(async () => {
    testDb = await createTestDatabase();
  });
  afterAll(async () => {
    await testDb.drop();
  });
  beforeEach(async () => {
    await testDb.reset();
    t = await buildAuthTestApp({ db: testDb.db.client });
    alice = newCredentials('alice');
    await register(t.app, alice);
  });

  const tokens = async (): Promise<TokenRow[]> =>
    (await testDb.sql.query<TokenRow>('SELECT * FROM refresh_token ORDER BY created_at, id')).rows;
  const rowOf = async (refreshToken: string): Promise<TokenRow | undefined> =>
    (await tokens()).find((row) => row.token_hash === hashRefreshToken(refreshToken));
  const liveCount = async (userId?: string): Promise<number> =>
    (await tokens()).filter(
      (row) => row.revoked_at === null && (userId === undefined || row.user_id === userId),
    ).length;

  const expectDeadRefresh = (response: request.Response) => {
    expect(response.status).toBe(401);
    expect(response.headers['content-type']).toMatch(PROBLEM_JSON);
    expect((response.body as { code: string }).code).toBe('INVALID_REFRESH_TOKEN');
  };

  describe('POST /v1/auth/refresh (FR-AUTH-003, S-AUTH-6)', () => {
    it('FR-AUTH-003: web refresh rotates the cookie and returns a new access token', async () => {
      const session = await loginWeb(t.app, alice);
      t.clock.advance(5 * MINUTE);
      const response = await refreshWeb(t.app, session.refreshToken);

      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const body = response.body as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['accessToken', 'expiresIn', 'tokenType']);
      const next = refreshCookieValue(response);
      expect(next).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(next).not.toBe(session.refreshToken);
      expect(setCookieLines(response)[0]).toMatch(
        /; Path=\/v1\/auth; .*HttpOnly; Secure; SameSite=Lax/,
      );
      expect(body['accessToken']).not.toBe(session.accessToken);
      expect((await getMe(t.app, body['accessToken'] as string)).status).toBe(200);
    });

    it('S-AUTH-6: rotation revokes the old token, links it to its successor and keeps the family', async () => {
      const session = await loginMobile(t.app, alice);
      const loginAt = t.clock.now().getTime();
      t.clock.advance(DAY);
      const response = await refreshMobile(t.app, session.refreshToken);
      expect(response.status).toBe(200);
      const next = (response.body as { refreshToken: string }).refreshToken;
      expect(setCookieLines(response)).toEqual([]);

      const [old, successor] = [await rowOf(session.refreshToken), await rowOf(next)];
      expect(await tokens()).toHaveLength(2);
      expect(old?.revoked_at?.getTime()).toBe(t.clock.now().getTime());
      expect(old?.replaced_by_id).toBe(successor?.id);
      expect(successor).toMatchObject({
        family_id: old?.family_id,
        user_id: session.userId,
        revoked_at: null,
        replaced_by_id: null,
      });
      // Idle deadline slides (14 days from use); the absolute deadline does not move.
      expect(successor?.expires_at.getTime()).toBe(t.clock.now().getTime() + 14 * DAY);
      expect(successor?.family_expires_at.getTime()).toBe(loginAt + 30 * DAY);
      expect(old?.family_expires_at.getTime()).toBe(loginAt + 30 * DAY);
    });

    it('S-AUTH-5: the session ID (sid) stays the same across rotation; the access token is new', async () => {
      const session = await loginMobile(t.app, alice);
      t.clock.advance(SECOND);
      const response = await refreshMobile(t.app, session.refreshToken);
      const claims = (token: string) =>
        JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as {
          sid: string;
          sub: string;
          iat: number;
        };
      const before = claims(session.accessToken);
      const after = claims((response.body as { accessToken: string }).accessToken);
      expect(after.sid).toBe(before.sid);
      expect(after.sub).toBe(session.userId);
      expect(after.iat).toBe(before.iat + 1);
      expect(before.sid).toBe((await rowOf(session.refreshToken))?.family_id);
    });

    it('S-AUTH-6: a chain of rotations works; every token is single-use', async () => {
      let current = (await loginMobile(t.app, alice)).refreshToken;
      const seen = new Set([current]);
      for (let i = 0; i < 5; i++) {
        t.clock.advance(MINUTE);
        const response = await refreshMobile(t.app, current);
        expect(response.status).toBe(200);
        current = (response.body as { refreshToken: string }).refreshToken;
        expect(seen.has(current)).toBe(false);
        seen.add(current);
      }
      expect(await tokens()).toHaveLength(6);
      expect(await liveCount()).toBe(1);
    });

    it('FR-AUTH-003 / S-AUTH-6: reuse of a rotated refresh token revokes the whole family and its session', async () => {
      const session = await loginMobile(t.app, alice);
      const rotated = await refreshMobile(t.app, session.refreshToken);
      const stolenFrom = rotated.body as { refreshToken: string; accessToken: string };
      expect((await getMe(t.app, stolenFrom.accessToken)).status).toBe(200);

      // The old token comes back: someone is replaying it.
      const replay = await refreshMobile(t.app, session.refreshToken);
      expectDeadRefresh(replay);
      expect((replay.body as Record<string, unknown>)['refreshToken']).toBeUndefined();

      // The newest token of the family is dead too, and so are the access tokens of the session.
      expect(await liveCount()).toBe(0);
      expectDeadRefresh(await refreshMobile(t.app, stolenFrom.refreshToken));
      expect((await getMe(t.app, stolenFrom.accessToken)).status).toBe(401);
      expect((await getMe(t.app, session.accessToken)).status).toBe(401);
      expect(await tokens()).toHaveLength(2); // nothing new was issued by any of this

      // The user can still sign in again: only that session was killed.
      const fresh = await loginMobile(t.app, alice);
      expect((await getMe(t.app, fresh.accessToken)).status).toBe(200);
    });

    it('S-AUTH-6: reuse detection works deep in a chain and for the web cookie; other sessions survive', async () => {
      const other = await loginMobile(t.app, alice);
      const web = await loginWeb(t.app, alice);
      const second = refreshCookieValue(await refreshWeb(t.app, web.refreshToken)) ?? '';
      const third = refreshCookieValue(await refreshWeb(t.app, second)) ?? '';
      expect(third).not.toBe('');

      const replay = await refreshWeb(t.app, web.refreshToken); // two generations old
      expectDeadRefresh(replay);
      // The browser is told to drop the dead cookie.
      expect(setCookieLines(replay)[0]).toMatch(/^akiba_refresh=; .*Expires=Thu, 01 Jan 1970/);
      expectDeadRefresh(await refreshWeb(t.app, third));

      // A different session of the same user is a different family and is untouched.
      expect((await getMe(t.app, other.accessToken)).status).toBe(200);
      expect((await refreshMobile(t.app, other.refreshToken)).status).toBe(200);
    });

    it('S-AUTH-6: an unknown, malformed or missing refresh token is 401 and revokes nothing', async () => {
      const session = await loginMobile(t.app, alice);
      const candidates = [
        'A'.repeat(43),
        'short',
        "' OR 1=1 --",
        session.accessToken,
        'x'.repeat(512),
      ];
      for (const candidate of candidates) {
        expectDeadRefresh(await refreshMobile(t.app, candidate));
        expectDeadRefresh(await refreshWeb(t.app, candidate));
      }
      expectDeadRefresh(await request(t.app).post('/v1/auth/refresh').set(MOBILE_HEADERS).send({}));
      expectDeadRefresh(await request(t.app).post('/v1/auth/refresh').set(MOBILE_HEADERS));
      expectDeadRefresh(await request(t.app).post('/v1/auth/refresh').set(WEB_HEADERS));
      expect(await liveCount()).toBe(1);
      // The stored HASH is not a credential.
      expectDeadRefresh(await refreshMobile(t.app, (await tokens())[0]?.token_hash ?? ''));
      expect((await refreshMobile(t.app, session.refreshToken)).status).toBe(200);
    });

    it('S-AUTH-2: rejects unknown body fields and over-long tokens with 422', async () => {
      const session = await loginMobile(t.app, alice);
      const extra = await request(t.app)
        .post('/v1/auth/refresh')
        .set(MOBILE_HEADERS)
        .send({ refreshToken: session.refreshToken, userId: randomUUID() });
      expect(extra.status).toBe(422);
      const long = await refreshMobile(t.app, 'x'.repeat(513));
      expect(long.status).toBe(422);
      expect(await liveCount()).toBe(1);
    });

    it('S-AUTH-6: idle timeout: a refresh token unused for 14 days is rejected', async () => {
      const session = await loginMobile(t.app, alice);
      t.clock.advance(14 * DAY - SECOND);
      const justInTime = await refreshMobile(t.app, session.refreshToken);
      expect(justInTime.status).toBe(200);

      const next = justInTime.body as { refreshToken: string; accessToken: string };
      t.clock.advance(14 * DAY);
      expectDeadRefresh(await refreshMobile(t.app, next.refreshToken));
      expect(await liveCount()).toBe(0);
      // Logging in again starts a new session.
      await loginMobile(t.app, alice);
    });

    it('S-AUTH-6: absolute timeout: no session lives past 30 days however often it is refreshed', async () => {
      let current = (await loginMobile(t.app, alice)).refreshToken;
      const loginAt = t.clock.now().getTime();
      // Refresh every 7 days: never idle for 14, so only the absolute limit can end it.
      for (let week = 1; week <= 4; week++) {
        t.clock.advance(7 * DAY);
        const response = await refreshMobile(t.app, current);
        expect(response.status).toBe(200);
        current = (response.body as { refreshToken: string }).refreshToken;
        const row = await rowOf(current);
        // The idle deadline is clamped to the family's absolute deadline.
        expect(row?.expires_at.getTime()).toBe(
          Math.min(t.clock.now().getTime() + 14 * DAY, loginAt + 30 * DAY),
        );
      }
      // Day 28 → day 30 minus a second: still valid; the successor expires at day 30 exactly.
      t.clock.advance(2 * DAY - SECOND);
      const last = await refreshMobile(t.app, current);
      expect(last.status).toBe(200);
      const final = last.body as { refreshToken: string; accessToken: string };
      expect((await rowOf(final.refreshToken))?.expires_at.getTime()).toBe(loginAt + 30 * DAY);
      expect((await getMe(t.app, final.accessToken)).status).toBe(200);

      t.clock.advance(SECOND);
      expectDeadRefresh(await refreshMobile(t.app, final.refreshToken));
      // The access token issued a second before the deadline dies with the session.
      expect((await getMe(t.app, final.accessToken)).status).toBe(401);
    });

    it('S-AUTH-5: an expired access token is 401; refreshing gives a working one', async () => {
      const session = await loginMobile(t.app, alice);
      t.clock.advance(15 * MINUTE - SECOND);
      expect((await getMe(t.app, session.accessToken)).status).toBe(200);
      t.clock.advance(SECOND);
      const expired = await getMe(t.app, session.accessToken);
      expect(expired.status).toBe(401);
      expect((expired.body as { code: string }).code).toBe('UNAUTHENTICATED');
      const refreshed = await refreshMobile(t.app, session.refreshToken);
      expect(
        (await getMe(t.app, (refreshed.body as { accessToken: string }).accessToken)).status,
      ).toBe(200);
    });

    it('S-AUTH-6: concurrent refreshes with the same token: exactly one succeeds (atomic rotation)', async () => {
      for (let round = 0; round < 3; round++) {
        const session = await loginMobile(t.app, alice);
        const before = (await tokens()).length;
        const responses = await Promise.all(
          Array.from({ length: 8 }, () => refreshMobile(t.app, session.refreshToken)),
        );
        const succeeded = responses.filter((response) => response.status === 200);
        const failed = responses.filter((response) => response.status === 401);
        expect(succeeded).toHaveLength(1);
        expect(failed).toHaveLength(7);
        // Exactly one successor was created, never two live tokens from one parent.
        expect((await tokens()).length).toBe(before + 1);
        const family = (await rowOf(session.refreshToken))?.family_id;
        const familyRows = (await tokens()).filter((row) => row.family_id === family);
        expect(familyRows).toHaveLength(2);
        // The losers presented an already-used token, which is reuse: the family is revoked,
        // including the winner's new token (strict S-AUTH-6; see the report on multi-tab clients).
        expect(familyRows.every((row) => row.revoked_at !== null)).toBe(true);
        const winner = succeeded[0]?.body as { refreshToken: string; accessToken: string };
        expectDeadRefresh(await refreshMobile(t.app, winner.refreshToken));
        expect((await getMe(t.app, winner.accessToken)).status).toBe(401);
      }
    });

    it('S-AUTH-6: concurrent refreshes of DIFFERENT sessions do not interfere', async () => {
      const sessions = await Promise.all(
        Array.from({ length: 4 }, () => loginMobile(t.app, alice)),
      );
      const responses = await Promise.all(
        sessions.map((session) => refreshMobile(t.app, session.refreshToken)),
      );
      expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
      expect(await liveCount()).toBe(4);
    });

    it('S-AUTH-6: a user in deletion cannot refresh, and their access tokens stop working', async () => {
      const session = await loginMobile(t.app, alice);
      await testDb.sql.query(`UPDATE "user" SET deleted_at = now() WHERE id = $1`, [
        session.userId,
      ]);
      expect((await getMe(t.app, session.accessToken)).status).toBe(401);
      expectDeadRefresh(await refreshMobile(t.app, session.refreshToken));
    });
  });

  describe('POST /v1/auth/logout (FR-AUTH-004)', () => {
    it('FR-AUTH-004: web logout revokes the current family, clears the cookie and ends the session', async () => {
      const session = await loginWeb(t.app, alice);
      const rotated = await refreshWeb(t.app, session.refreshToken);
      const current = refreshCookieValue(rotated) ?? '';
      const access = (rotated.body as { accessToken: string }).accessToken;

      const response = await request(t.app)
        .post('/v1/auth/logout')
        .set(WEB_HEADERS)
        .set('Cookie', cookieHeader(current));
      expect(response.status).toBe(204);
      expect(response.text).toBe('');
      const [cleared] = setCookieLines(response);
      expect(cleared).toMatch(/^akiba_refresh=; /);
      expect(cleared).toMatch(/Path=\/v1\/auth/);
      expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
      expect(cleared).toMatch(/HttpOnly/);

      expect(await liveCount()).toBe(0);
      expectDeadRefresh(await refreshWeb(t.app, current));
      expect((await getMe(t.app, access)).status).toBe(401);
    });

    it('FR-AUTH-004: mobile logout takes the token from the body and sets no cookie', async () => {
      const session = await loginMobile(t.app, alice);
      const response = await request(t.app)
        .post('/v1/auth/logout')
        .set(MOBILE_HEADERS)
        .send({ refreshToken: session.refreshToken });
      expect(response.status).toBe(204);
      expect(setCookieLines(response)).toEqual([]);
      expectDeadRefresh(await refreshMobile(t.app, session.refreshToken));
      expect((await getMe(t.app, session.accessToken)).status).toBe(401);
    });

    it('FR-AUTH-004: logout ends only the current device; other sessions keep working', async () => {
      const phone = await loginMobile(t.app, alice);
      const laptop = await loginWeb(t.app, alice);
      await request(t.app)
        .post('/v1/auth/logout')
        .set(MOBILE_HEADERS)
        .send({ refreshToken: phone.refreshToken })
        .expect(204);
      expect((await getMe(t.app, phone.accessToken)).status).toBe(401);
      expect((await getMe(t.app, laptop.accessToken)).status).toBe(200);
      expect((await refreshWeb(t.app, laptop.refreshToken)).status).toBe(200);
    });

    it('FR-AUTH-004: logout is idempotent and never fails for a bad, old or missing token', async () => {
      const session = await loginMobile(t.app, alice);
      const logout = (body?: object) => {
        const pending = request(t.app).post('/v1/auth/logout').set(MOBILE_HEADERS);
        return body === undefined ? pending : pending.send(body);
      };
      for (let i = 0; i < 3; i++) {
        expect((await logout({ refreshToken: session.refreshToken })).status).toBe(204);
      }
      expect((await logout({ refreshToken: 'A'.repeat(43) })).status).toBe(204);
      expect((await logout({ refreshToken: 'garbage' })).status).toBe(204);
      expect((await logout({})).status).toBe(204);
      expect((await logout()).status).toBe(204);
      const web = await request(t.app).post('/v1/auth/logout').set(WEB_HEADERS);
      expect(web.status).toBe(204);
      expect(setCookieLines(web)[0]).toMatch(/^akiba_refresh=; /);
      const rows = await tokens();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.revoked_at).not.toBeNull();
    });

    it('FR-AUTH-004: logging out with an already-rotated token still ends the whole session', async () => {
      const session = await loginMobile(t.app, alice);
      const rotated = await refreshMobile(t.app, session.refreshToken);
      const next = rotated.body as { refreshToken: string; accessToken: string };
      await request(t.app)
        .post('/v1/auth/logout')
        .set(MOBILE_HEADERS)
        .send({ refreshToken: session.refreshToken })
        .expect(204);
      expect(await liveCount()).toBe(0);
      expect((await getMe(t.app, next.accessToken)).status).toBe(401);
    });
  });

  describe('POST /v1/auth/logout-all (FR-AUTH-004)', () => {
    it('FR-AUTH-004: revokes every session of the user and clears the cookie', async () => {
      const phone = await loginMobile(t.app, alice);
      const tablet = await loginMobile(t.app, alice);
      const laptop = await loginWeb(t.app, alice);
      expect(await liveCount()).toBe(3);

      const response = await request(t.app)
        .post('/v1/auth/logout-all')
        .set(WEB_HEADERS)
        .set('Authorization', `Bearer ${laptop.accessToken}`);
      expect(response.status).toBe(204);
      expect(setCookieLines(response)[0]).toMatch(/^akiba_refresh=; /);

      expect(await liveCount()).toBe(0);
      for (const session of [phone, tablet, laptop]) {
        expect((await getMe(t.app, session.accessToken)).status).toBe(401);
      }
      expectDeadRefresh(await refreshMobile(t.app, phone.refreshToken));
      expectDeadRefresh(await refreshMobile(t.app, tablet.refreshToken));
      expectDeadRefresh(await refreshWeb(t.app, laptop.refreshToken));
      // Signing in again works.
      const again = await loginMobile(t.app, alice);
      expect((await getMe(t.app, again.accessToken)).status).toBe(200);
    });

    it('FR-AUTH-004: requires a valid access token; the refresh token or cookie is not enough', async () => {
      const session = await loginWeb(t.app, alice);
      const noToken = await request(t.app).post('/v1/auth/logout-all').set(WEB_HEADERS);
      expect(noToken.status).toBe(401);
      const cookieOnly = await request(t.app)
        .post('/v1/auth/logout-all')
        .set(WEB_HEADERS)
        .set('Cookie', cookieHeader(session.refreshToken));
      expect(cookieOnly.status).toBe(401);
      const bodyUser = await request(t.app)
        .post('/v1/auth/logout-all')
        .set(MOBILE_HEADERS)
        .send({ userId: session.userId });
      expect(bodyUser.status).toBe(401);
      expect(await liveCount()).toBe(1);
    });

    it('FR-AUTH-004: idempotent in effect: repeating it changes nothing (the repeat is 401, its session is gone)', async () => {
      const session = await loginMobile(t.app, alice);
      const call = () =>
        request(t.app)
          .post('/v1/auth/logout-all')
          .set(MOBILE_HEADERS)
          .set('Authorization', `Bearer ${session.accessToken}`);
      expect((await call()).status).toBe(204);
      const after = await tokens();
      expect((await call()).status).toBe(401);
      expect(await tokens()).toEqual(after);
      // From a second live session it succeeds again with nothing left to revoke but itself.
      const second = await loginMobile(t.app, alice);
      const repeat = await request(t.app)
        .post('/v1/auth/logout-all')
        .set(MOBILE_HEADERS)
        .set('Authorization', `Bearer ${second.accessToken}`);
      expect(repeat.status).toBe(204);
      expect(await liveCount()).toBe(0);
    });
  });

  describe('isolation between users (doc 09 §3, NFR-SEC-004)', () => {
    let bob: Credentials;
    let aliceSession: TestSession;
    let bobSession: TestSession;

    beforeEach(async () => {
      bob = newCredentials('bob');
      await register(t.app, bob);
      aliceSession = await loginMobile(t.app, alice);
      bobSession = await loginMobile(t.app, bob);
    });

    const aliceUntouched = async () => {
      expect(await liveCount(aliceSession.userId)).toBe(1);
      const me = await getMe(t.app, aliceSession.accessToken);
      expect(me.status).toBe(200);
      expect((me.body as { id: string }).id).toBe(aliceSession.userId);
    };

    it('NFR-SEC-004: each access token resolves to its own user only', async () => {
      const [a, b] = [
        await getMe(t.app, aliceSession.accessToken),
        await getMe(t.app, bobSession.accessToken),
      ];
      expect(a.body).toMatchObject({ id: aliceSession.userId, email: alice.email });
      expect(b.body).toMatchObject({ id: bobSession.userId, email: bob.email });
      expect(aliceSession.userId).not.toBe(bobSession.userId);
      // Request input cannot select another user.
      const sneaky = await request(t.app)
        .get(`/v1/me?userId=${aliceSession.userId}`)
        .set('Authorization', `Bearer ${bobSession.accessToken}`)
        .set('X-User-Id', aliceSession.userId);
      expect((sneaky.body as { id: string }).id).toBe(bobSession.userId);
    });

    it("NFR-SEC-004: B's logout, logout-all and refresh-token reuse never touch A's sessions", async () => {
      // B logs out everywhere.
      await request(t.app)
        .post('/v1/auth/logout-all')
        .set(MOBILE_HEADERS)
        .set('Authorization', `Bearer ${bobSession.accessToken}`)
        .send({ userId: aliceSession.userId })
        .expect(204);
      expect(await liveCount(bobSession.userId)).toBe(0);
      await aliceUntouched();

      // B triggers reuse detection on a family of his own.
      const second = await loginMobile(t.app, bob);
      await refreshMobile(t.app, second.refreshToken);
      expectDeadRefresh(await refreshMobile(t.app, second.refreshToken));
      await aliceUntouched();

      // B logs out a single session.
      const third = await loginMobile(t.app, bob);
      await request(t.app)
        .post('/v1/auth/logout')
        .set(MOBILE_HEADERS)
        .send({ refreshToken: third.refreshToken })
        .expect(204);
      await aliceUntouched();
      expect((await refreshMobile(t.app, aliceSession.refreshToken)).status).toBe(200);
    });

    it("NFR-SEC-004: B's access token cannot be used to refresh or end A's session, and vice versa", async () => {
      // A refresh request is authorised by the refresh token alone; a bearer token changes nothing.
      const response = await request(t.app)
        .post('/v1/auth/refresh')
        .set(MOBILE_HEADERS)
        .set('Authorization', `Bearer ${bobSession.accessToken}`)
        .send({ refreshToken: aliceSession.refreshToken });
      expect(response.status).toBe(200);
      const body = response.body as { accessToken: string };
      // The new access token belongs to the owner of the REFRESH token (Alice), not to Bob.
      expect(((await getMe(t.app, body.accessToken)).body as { id: string }).id).toBe(
        aliceSession.userId,
      );
      expect(await liveCount(bobSession.userId)).toBe(1);
    });

    it("NFR-SEC-004: a validly signed token naming another user's session (sub=A, sid=B) is rejected", async () => {
      const key = await importJWK({ ...t.signingJwk }, 'EdDSA');
      const iat = Math.floor(t.clock.now().getTime() / 1000);
      const sidOf = (token: string) =>
        (
          JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as {
            sid: string;
          }
        ).sid;
      const mint = (sub: string, sid: string) =>
        new SignJWT({ sid })
          .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid: t.signingJwk.kid })
          .setIssuer(t.config.auth.jwt.issuer)
          .setAudience(t.config.auth.jwt.audience)
          .setSubject(sub)
          .setIssuedAt(iat)
          .setExpirationTime(iat + 900)
          .sign(key);

      // Control: the same minting with matching user and session is accepted.
      const matching = await mint(aliceSession.userId, sidOf(aliceSession.accessToken));
      expect((await getMe(t.app, matching)).status).toBe(200);
      // A session only authorises the user it belongs to.
      const crossed = await mint(aliceSession.userId, sidOf(bobSession.accessToken));
      expect((await getMe(t.app, crossed)).status).toBe(401);
      // An unknown session, or an unknown user with a real session, is rejected too.
      expect((await getMe(t.app, await mint(aliceSession.userId, randomUUID()))).status).toBe(401);
      expect(
        (await getMe(t.app, await mint(randomUUID(), sidOf(aliceSession.accessToken)))).status,
      ).toBe(401);
    });
  });

  describe('JWT abuse cases over HTTP (S-AUTH-5, doc 11 §3.1)', () => {
    let session: TestSession;
    let claims: Record<string, unknown>;

    const b64 = (value: unknown): string =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const expect401 = async (token: string) => {
      const response = await getMe(t.app, token);
      expect(response.status).toBe(401);
      expect((response.body as { code: string }).code).toBe('UNAUTHENTICATED');
      expect(response.headers['www-authenticate']).toBe('Bearer');
    };
    /** Sign with the app's real key, so that only the altered claim/header can be the reason. */
    const signReal = async (
      overrides: Record<string, unknown>,
      header: Record<string, unknown> = {},
    ): Promise<string> =>
      new SignJWT({ ...claims, ...overrides })
        .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid: t.signingJwk.kid, ...header })
        .sign(await importJWK({ ...t.signingJwk }, 'EdDSA'));

    beforeEach(async () => {
      session = await loginMobile(t.app, alice);
      claims = JSON.parse(
        Buffer.from(session.accessToken.split('.')[1] ?? '', 'base64url').toString(),
      ) as Record<string, unknown>;
    });

    it('S-AUTH-5: control: a re-signed copy of the real claims is accepted', async () => {
      expect((await getMe(t.app, await signReal({}))).status).toBe(200);
    });

    it('S-AUTH-5: alg "none" → 401', async () => {
      const header = b64({ alg: 'none', typ: 'JWT', kid: t.signingJwk.kid });
      await expect401(`${header}.${b64(claims)}.`);
      // With the original signature attached as well.
      await expect401(`${header}.${b64(claims)}.${session.accessToken.split('.')[2]}`);
    });

    it('S-AUTH-5: wrong alg (HS256 signed with the public key) → 401', async () => {
      const { createHmac, createPublicKey } = await import('node:crypto');
      const publicKey = createPublicKey({
        key: { kty: 'OKP', crv: 'Ed25519', x: t.signingJwk.x },
        format: 'jwk',
      });
      const header = b64({ alg: 'HS256', typ: 'JWT', kid: t.signingJwk.kid });
      for (const secret of [
        publicKey.export({ format: 'pem', type: 'spki' }),
        publicKey.export({ format: 'der', type: 'spki' }),
        Buffer.from(t.signingJwk.x, 'base64url'),
      ]) {
        const signature = createHmac('sha256', secret)
          .update(`${header}.${b64(claims)}`)
          .digest('base64url');
        await expect401(`${header}.${b64(claims)}.${signature}`);
      }
    });

    it('S-AUTH-5: tampered payload or signature → 401', async () => {
      const [header, payload, signature] = session.accessToken.split('.') as [
        string,
        string,
        string,
      ];
      await expect401(`${header}.${b64({ ...claims, sub: randomUUID() })}.${signature}`);
      await expect401(
        `${header}.${b64({ ...claims, exp: (claims['exp'] as number) + 3600 })}.${signature}`,
      );
      const bytes = Buffer.from(signature, 'base64url');
      bytes[10] = (bytes[10] ?? 0) ^ 0xff;
      await expect401(`${header}.${payload}.${bytes.toString('base64url')}`);
    });

    it('S-AUTH-5: wrong aud or iss → 401', async () => {
      await expect401(await signReal({ aud: 'some-other-api' }));
      await expect401(await signReal({ iss: 'https://evil.example' }));
      await expect401(await signReal({ aud: undefined }));
      await expect401(await signReal({ iss: undefined }));
    });

    it('S-AUTH-5: expired → 401 (also when re-signed with an old exp)', async () => {
      const now = Math.floor(t.clock.now().getTime() / 1000);
      await expect401(await signReal({ iat: now - 1000, exp: now - 1 }));
      await expect401(await signReal({ exp: now }));
      expect((await getMe(t.app, await signReal({ exp: now + 1 }))).status).toBe(200);
    });

    it('S-AUTH-5: missing or unknown kid, or a key from another issuer → 401', async () => {
      const real = await importJWK({ ...t.signingJwk }, 'EdDSA');
      const noKid = await new SignJWT(claims)
        .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
        .sign(real);
      await expect401(noKid);
      await expect401(await signReal({}, { kid: 'some-other-key' }));

      const attacker = await generateSigningJwk();
      const attackerKey = await importJWK({ ...attacker }, 'EdDSA');
      for (const kid of [attacker.kid, t.signingJwk.kid]) {
        const forged = await new SignJWT(claims)
          .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid })
          .sign(attackerKey);
        await expect401(forged);
      }
      // Tokens from another instance of this very application (its own generated key).
      const otherApp = await buildAuthTestApp({ db: testDb.db.client });
      const foreign = await loginMobile(otherApp.app, alice);
      expect((await getMe(otherApp.app, foreign.accessToken)).status).toBe(200);
      await expect401(foreign.accessToken);
    });

    it('S-AUTH-5: tokens signed with the previous key are accepted during rotation only', async () => {
      const previousPublic = {
        kty: 'OKP',
        crv: 'Ed25519',
        x: t.signingJwk.x,
        kid: t.signingJwk.kid,
      };
      const rotated = await buildAuthTestApp({
        db: testDb.db.client,
        clock: t.clock,
        env: { AUTH_JWT_PREVIOUS_PUBLIC_JWK: JSON.stringify(previousPublic) },
      });
      expect(rotated.signingJwk.kid).not.toBe(t.signingJwk.kid);
      expect((await getMe(rotated.app, session.accessToken)).status).toBe(200);
      const unrelated = await buildAuthTestApp({ db: testDb.db.client, clock: t.clock });
      expect((await getMe(unrelated.app, session.accessToken)).status).toBe(401);
    });
  });

  describe('per-user rate limits on authenticated routes (doc 07 §1, NFR-SEC-005)', () => {
    it('NFR-SEC-005: reads are limited per user, independently of other users', async () => {
      const bob = newCredentials('bob');
      await register(t.app, bob);
      const perUser = await buildPerUserLimitedApp({ reads: 3, writes: 2 });
      const a = await loginMobile(perUser.app, alice);
      const b = await loginMobile(perUser.app, bob);

      for (let i = 1; i <= 3; i++) {
        const response = await getMe(perUser.app, a.accessToken);
        expect(response.status).toBe(200);
        expect(response.headers['ratelimit-limit']).toBe('3');
        expect(response.headers['ratelimit-remaining']).toBe(String(3 - i));
      }
      const blocked = await getMe(perUser.app, a.accessToken);
      expect(blocked.status).toBe(429);
      expect(blocked.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      // Same IP, different user: not affected.
      expect((await getMe(perUser.app, b.accessToken)).status).toBe(200);
      // A new session of the limited user shares the user's budget (keyed by user, not token).
      const second = await loginMobile(perUser.app, alice);
      expect((await getMe(perUser.app, second.accessToken)).status).toBe(429);
      // Unauthenticated requests are refused before they can consume anyone's budget.
      expect((await getMe(perUser.app, 'garbage')).status).toBe(401);

      perUser.clock.advance(MINUTE);
      expect((await getMe(perUser.app, a.accessToken)).status).toBe(200);
    });

    it('NFR-SEC-005: writes have their own, lower per-user budget', async () => {
      const perUser = await buildPerUserLimitedApp({ reads: 50, writes: 2 });
      const session = await loginMobile(perUser.app, alice);
      const logoutAll = () =>
        request(perUser.app)
          .post('/v1/auth/logout-all')
          .set(MOBILE_HEADERS)
          .set('Authorization', `Bearer ${session.accessToken}`);
      // Budget is 2 writes per user per minute (reads: 50). The first call ends the session, so later
      // calls would be 401 anyway; log in again to keep a valid token for the same user.
      expect((await logoutAll()).status).toBe(204);
      const again = await loginMobile(perUser.app, alice);
      const call = () =>
        request(perUser.app)
          .post('/v1/auth/logout-all')
          .set(MOBILE_HEADERS)
          .set('Authorization', `Bearer ${again.accessToken}`);
      expect((await call()).status).toBe(204);
      const third = await loginMobile(perUser.app, alice);
      const blocked = await request(perUser.app)
        .post('/v1/auth/logout-all')
        .set(MOBILE_HEADERS)
        .set('Authorization', `Bearer ${third.accessToken}`);
      expect(blocked.status).toBe(429);
      // The refused write changed nothing, and reads are still allowed.
      expect((await getMe(perUser.app, third.accessToken)).status).toBe(200);
    });

    /**
     * An app whose per-USER budgets are small. The per-user limiters take their numbers from the
     * same settings as the per-IP ones (doc 07 gives both the same values), so the app-level
     * per-IP limiters get a generous config and their own store here; otherwise they would trip
     * first and the test could not tell the two apart.
     */
    async function buildPerUserLimitedApp(budget: {
      reads: number;
      writes: number;
    }): Promise<AuthTestApp> {
      const base = await buildAuthTestApp({
        db: testDb.db.client,
        env: {
          API_RATE_LIMIT_MAX: String(budget.reads),
          API_RATE_LIMIT_WRITE_MAX: String(budget.writes),
        },
      });
      const app = createApp({
        config: testConfig({ API_RATE_LIMIT_MAX: '100000', API_RATE_LIMIT_WRITE_MAX: '100000' }),
        logger: createLogger({ level: 'silent' }),
        rateLimitStore: new MemoryRateLimitStore(),
        v1Router: base.auth.router,
      });
      return { ...base, app };
    }
  });
});
