import { createHash } from 'node:crypto';
import { Router } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { createLogger } from '../../lib/logger.js';
import {
  buildAuthTestApp,
  DAY,
  getMe,
  loginMobile,
  loginWeb,
  MINUTE,
  MOBILE_HEADERS,
  newCredentials,
  refreshMobile,
  refreshWeb,
  register,
  setCookieLines,
  WEB_HEADERS,
  type AuthTestApp,
  type Credentials,
} from '../../testing/auth.js';
import { createTestDatabase, type TestDatabase } from '../../testing/database.js';
import { LogSink } from '../../testing/harness.js';
import type { EmailKind, EmailMessage } from '../email/index.js';

const PROBLEM_JSON = /^application\/problem\+json/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const HOUR = 60 * MINUTE;
const NEW_PASSWORD = 'a brand new passphrase 7';

/** Everything a client can see of a response except the per-request values. */
function visible(response: request.Response): Record<string, unknown> {
  const { requestId, ...body } = response.body as Record<string, unknown>;
  return {
    status: response.status,
    body,
    hasRequestId: requestId !== undefined,
    contentType: response.headers['content-type'],
    cacheControl: response.headers['cache-control'],
    cookies: setCookieLines(response),
  };
}

/** The one-time token carried by the link in an email. */
function tokenIn(message: EmailMessage): string {
  const match = /#token=([^\s"<]+)/.exec(message.text);
  if (match?.[1] === undefined) throw new Error(`the ${message.kind} email has no token link`);
  return match[1];
}

const INVALID_TOKEN_PROBLEM = {
  type: '/errors/invalid-token',
  title: 'Invalid or expired link',
  status: 400,
  code: 'INVALID_TOKEN',
  detail: 'This link is invalid, has expired or was already used. Request a new one.',
};

describe('auth email flows (T5): verification, password reset, password change', () => {
  let testDb: TestDatabase;
  let t: AuthTestApp;

  beforeAll(async () => {
    testDb = await createTestDatabase();
  });
  afterAll(async () => {
    await testDb.drop();
  });
  beforeEach(async () => {
    await testDb.reset();
    t = await buildAuthTestApp({ db: testDb.db.client });
  });

  // ── helpers ──

  const post = (path: string, body?: object): request.Test => {
    const call = request(t.app).post(`/v1/auth${path}`);
    return body === undefined ? call : call.send(body);
  };

  const authed = (path: string, accessToken: string, body?: object): request.Test =>
    post(path, body).set('Authorization', `Bearer ${accessToken}`);

  /** Register and wait until the verification email is out. */
  async function registered(label = 'user'): Promise<Credentials> {
    const credentials = newCredentials(label);
    await register(t.app, credentials);
    await t.settle();
    return credentials;
  }

  const emailsOf = (address: string, kind: EmailKind): EmailMessage[] =>
    t.emails.to(address).filter((message) => message.kind === kind);

  async function forgot(email: string): Promise<request.Response> {
    const response = await post('/password/forgot', { email });
    await t.settle();
    return response;
  }

  /** Ask for a reset link and return its token. */
  async function resetToken(email: string): Promise<string> {
    await forgot(email);
    return tokenIn(t.emails.last(email, 'reset_password'));
  }

  const userRow = async (email: string) => {
    const result = await testDb.sql.query<{
      id: string;
      password_hash: string | null;
      email_verified_at: Date | null;
    }>('SELECT id, password_hash, email_verified_at FROM "user" WHERE email = $1', [email]);
    const row = result.rows[0];
    if (row === undefined) throw new Error('no such user');
    return row;
  };

  const tokenRows = async () =>
    (
      await testDb.sql.query<{
        user_id: string;
        purpose: string;
        token_hash: string;
        sent_to: string;
        expires_at: Date;
        used_at: Date | null;
      }>('SELECT * FROM one_time_token ORDER BY expires_at')
    ).rows;

  const canLogIn = async (credentials: Credentials): Promise<boolean> =>
    (await post('/login', credentials).set(MOBILE_HEADERS)).status === 200;

  // ── registration email ──

  describe('registration email (FR-AUTH-006)', () => {
    it('FR-AUTH-006: registering sends exactly one verification email with a one-time link to the web app', async () => {
      const credentials = await registered();

      expect(t.emails.sent).toHaveLength(1);
      const message = t.emails.last(credentials.email, 'verify_email');
      expect(message.to).toBe(credentials.email);
      const token = tokenIn(message);
      expect(token).toMatch(TOKEN);
      expect(message.text).toContain(`http://localhost:5173/verify-email#token=${token}`);
      expect(message.html).toContain(`href="http://localhost:5173/verify-email#token=${token}"`);

      const rows = await tokenRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        purpose: 'verify_email',
        sent_to: credentials.email,
        used_at: null,
        expires_at: new Date(t.clock.now().getTime() + DAY),
      });
    });

    it('FR-AUTH-006 / S-AUTH-3: registering an existing address answers identically and sends its owner a notice without a token', async () => {
      const credentials = await registered('owner');
      const fresh = newCredentials('fresh');
      t.emails.clear();

      const first = await post('/register', { ...fresh, displayName: 'New' });
      const again = await post('/register', {
        email: credentials.email.toUpperCase(),
        password: 'a completely different pw 1',
        displayName: 'Mallory',
      });
      await t.settle();

      expect(again.status).toBe(201);
      expect(visible(again)).toEqual(visible(first));

      const toOwner = t.emails.to(credentials.email);
      expect(toOwner.map((message) => message.kind)).toEqual(['registration_attempt']);
      expect(toOwner[0]?.text).not.toContain('token=');
      expect(toOwner[0]?.html).not.toContain('token=');
      // Nothing about the existing account changed: same password, same single (older) token.
      expect(await canLogIn(credentials)).toBe(true);
      expect((await tokenRows()).filter((row) => row.sent_to === credentials.email)).toHaveLength(
        1,
      );
      expect((await userRow(credentials.email)).email_verified_at).toBeNull();
    });

    it('FR-AUTH-006: the "already registered" notice is limited per address', async () => {
      const credentials = await registered('owner');
      t.emails.clear();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await post('/register', { ...credentials, displayName: 'Again' });
        expect(response.status).toBe(201);
      }
      await t.settle();
      expect(emailsOf(credentials.email, 'registration_attempt')).toHaveLength(3);
    });

    it('FR-AUTH-006: a failing email provider does not change the registration response', async () => {
      t.emails.failWith = new Error('provider down: https://example.test/verify-email#token=LEAK');
      const credentials = newCredentials();
      const response = await post('/register', { ...credentials, displayName: 'Ada' });
      await t.settle();

      expect(response.status).toBe(201);
      expect(response.body).toEqual({ status: 'verification_pending' });
      expect(await canLogIn(credentials)).toBe(true);
      const failures = t.logs.lines.filter((line) => line['event'] === 'background_task_failed');
      expect(failures).toHaveLength(1);
      // The provider's error text (which could quote the message) is not logged.
      expect(t.logs.text).not.toContain('LEAK');
    });
  });

  // ── verify email ──

  describe('POST /v1/auth/verify-email (FR-AUTH-006, S-AUTH-10)', () => {
    it('FR-AUTH-006 / Q-04: an unverified user can log in, sees emailVerified=false, and the link verifies the address', async () => {
      const credentials = await registered();
      const session = await loginMobile(t.app, credentials);
      expect((await getMe(t.app, session.accessToken)).body).toMatchObject({
        emailVerified: false,
      });

      t.clock.advance(5 * MINUTE);
      const token = tokenIn(t.emails.last(credentials.email, 'verify_email'));
      const response = await post('/verify-email', { token });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'verified' });
      expect(response.headers['cache-control']).toBe('no-store');
      expect((await userRow(credentials.email)).email_verified_at).toEqual(t.clock.now());
      // The same access token sees the new state at once.
      expect((await getMe(t.app, session.accessToken)).body).toMatchObject({ emailVerified: true });
      const login = await post('/login', credentials).set(MOBILE_HEADERS);
      expect((login.body as { user: { emailVerified: boolean } }).user.emailVerified).toBe(true);
    });

    it('S-AUTH-10: a verification token works once', async () => {
      const credentials = await registered();
      const token = tokenIn(t.emails.last(credentials.email, 'verify_email'));
      expect((await post('/verify-email', { token })).status).toBe(200);
      const verifiedAt = (await userRow(credentials.email)).email_verified_at;

      t.clock.advance(MINUTE);
      const second = await post('/verify-email', { token });
      expect(second.status).toBe(400);
      expect(second.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(second.body).toMatchObject(INVALID_TOKEN_PROBLEM);
      expect((await userRow(credentials.email)).email_verified_at).toEqual(verifiedAt);
    });

    it('S-AUTH-10: of two concurrent uses of one verification token exactly one succeeds', async () => {
      const credentials = await registered();
      const token = tokenIn(t.emails.last(credentials.email, 'verify_email'));
      const responses = await Promise.all(
        Array.from({ length: 6 }, () => post('/verify-email', { token })),
      );
      expect(responses.map((response) => response.status).sort()).toEqual([
        200, 400, 400, 400, 400, 400,
      ]);
    });

    it('S-AUTH-10: a verification token expires after 24 hours', async () => {
      const early = await registered('early');
      const late = await registered('late');
      const earlyToken = tokenIn(t.emails.last(early.email, 'verify_email'));
      const lateToken = tokenIn(t.emails.last(late.email, 'verify_email'));

      t.clock.advance(DAY - 1000);
      expect((await post('/verify-email', { token: earlyToken })).status).toBe(200);

      t.clock.advance(1000);
      const expired = await post('/verify-email', { token: lateToken });
      expect(expired.status).toBe(400);
      expect(expired.body).toMatchObject(INVALID_TOKEN_PROBLEM);
      expect((await userRow(late.email)).email_verified_at).toBeNull();
    });

    it('S-AUTH-10: unknown, tampered, malformed, expired, used and wrong-purpose tokens all get the same answer', async () => {
      const credentials = await registered();
      const other = await registered('other');
      const token = tokenIn(t.emails.last(credentials.email, 'verify_email'));
      const tampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
      const reset = await resetToken(credentials.email);

      const usedToken = tokenIn(t.emails.last(other.email, 'verify_email'));
      expect((await post('/verify-email', { token: usedToken })).status).toBe(200);

      const cases = {
        unknown: 'A'.repeat(43),
        tampered,
        malformed: 'not a token',
        tooLong: 'A'.repeat(400),
        withPadding: `${token}=`,
        used: usedToken,
        wrongPurpose: reset,
      };
      const seen = new Set<string>();
      for (const candidate of Object.values(cases)) {
        const response = await post('/verify-email', { token: candidate });
        expect(response.status).toBe(400);
        expect(response.body).toMatchObject(INVALID_TOKEN_PROBLEM);
        seen.add(JSON.stringify(visible(response)));
      }
      expect(seen.size).toBe(1);
      expect((await userRow(credentials.email)).email_verified_at).toBeNull();

      // None of that used up the real tokens: wrong-purpose and near-miss attempts cost nothing.
      expect((await post('/verify-email', { token })).status).toBe(200);
      expect(
        (await post('/password/reset', { token: reset, newPassword: NEW_PASSWORD })).status,
      ).toBe(200);
    });

    it('S-AUTH-10: a token only verifies the address it was sent to', async () => {
      const credentials = await registered();
      const token = tokenIn(t.emails.last(credentials.email, 'verify_email'));
      // What a later change-of-email feature would do to the account.
      await testDb.sql.query('UPDATE "user" SET email = $2 WHERE email = $1', [
        credentials.email,
        'moved@example.test',
      ]);

      const response = await post('/verify-email', { token });
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject(INVALID_TOKEN_PROBLEM);
      expect((await userRow('moved@example.test')).email_verified_at).toBeNull();
    });

    it('S-AUTH-10: the link of an account in deletion does not verify it', async () => {
      const credentials = await registered();
      const token = tokenIn(t.emails.last(credentials.email, 'verify_email'));
      await testDb.sql.query('UPDATE "user" SET deleted_at = now() WHERE email = $1', [
        credentials.email,
      ]);
      expect((await post('/verify-email', { token })).status).toBe(400);
      expect((await userRow(credentials.email)).email_verified_at).toBeNull();
    });

    it('FR-AUTH-006: a missing token or an unknown field is a validation error', async () => {
      const missing = await post('/verify-email', {});
      expect(missing.status).toBe(422);
      expect(missing.body).toMatchObject({ code: 'VALIDATION_ERROR' });
      const extra = await post('/verify-email', { token: 'A'.repeat(43), userId: 'x' });
      expect(extra.status).toBe(422);
    });
  });

  describe('POST /v1/auth/verify-email/resend (FR-AUTH-006)', () => {
    it('FR-AUTH-006 / S-AUTH-10: resending issues a new link and the old one stops working', async () => {
      const credentials = await registered();
      const oldToken = tokenIn(t.emails.last(credentials.email, 'verify_email'));
      const session = await loginMobile(t.app, credentials);

      const response = await authed('/verify-email/resend', session.accessToken);
      await t.settle();
      expect(response.status).toBe(202);
      expect(response.body).toEqual({ status: 'accepted' });

      expect(emailsOf(credentials.email, 'verify_email')).toHaveLength(2);
      const newToken = tokenIn(t.emails.last(credentials.email, 'verify_email'));
      expect(newToken).not.toBe(oldToken);
      expect(await tokenRows()).toHaveLength(1);

      expect((await post('/verify-email', { token: oldToken })).status).toBe(400);
      expect((await userRow(credentials.email)).email_verified_at).toBeNull();
      expect((await post('/verify-email', { token: newToken })).status).toBe(200);
    });

    it('FR-AUTH-006: resend needs a session; the address comes from the session, not the request', async () => {
      const credentials = await registered();
      const victim = await registered('victim');
      t.emails.clear();

      const anonymous = await post('/verify-email/resend', { email: victim.email });
      expect(anonymous.status).toBe(401);

      const session = await loginMobile(t.app, credentials);
      const response = await authed('/verify-email/resend', session.accessToken, {
        email: victim.email,
      });
      await t.settle();
      expect(response.status).toBe(202);
      expect(t.emails.to(victim.email)).toEqual([]);
      expect(emailsOf(credentials.email, 'verify_email')).toHaveLength(1);
    });

    it('FR-AUTH-006: an already verified user gets the same 202 and no email', async () => {
      const credentials = await registered();
      const token = tokenIn(t.emails.last(credentials.email, 'verify_email'));
      await post('/verify-email', { token });
      const session = await loginMobile(t.app, credentials);
      t.emails.clear();

      const response = await authed('/verify-email/resend', session.accessToken);
      await t.settle();
      expect(response.status).toBe(202);
      expect(response.body).toEqual({ status: 'accepted' });
      expect(t.emails.sent).toEqual([]);
      // No new token either: the only row is the used one.
      expect((await tokenRows()).map((row) => row.used_at !== null)).toEqual([true]);
    });

    it('FR-AUTH-006: at most three verification emails per address per hour; the last delivered link keeps working', async () => {
      const credentials = await registered(); // email 1
      const session = await loginMobile(t.app, credentials);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const response = await authed('/verify-email/resend', session.accessToken);
        expect(response.status).toBe(202);
        await t.settle();
      }
      expect(emailsOf(credentials.email, 'verify_email')).toHaveLength(3);
      // The suppressed requests did not replace the token whose email did go out.
      const lastDelivered = tokenIn(t.emails.last(credentials.email, 'verify_email'));

      t.clock.advance(HOUR);
      // The access token from before has expired by now (15 minutes); sign in again.
      const later = await loginMobile(t.app, credentials);
      await authed('/verify-email/resend', later.accessToken);
      await t.settle();
      expect(emailsOf(credentials.email, 'verify_email')).toHaveLength(4);
      expect((await post('/verify-email', { token: lastDelivered })).status).toBe(400);
      const newest = tokenIn(t.emails.last(credentials.email, 'verify_email'));
      expect((await post('/verify-email', { token: newest })).status).toBe(200);
    });
  });

  // ── one-time tokens at rest ──

  describe('one-time tokens (S-AUTH-10)', () => {
    it('S-AUTH-10: tokens are 256 random bits, base64url, and never repeat', async () => {
      const tokens = new Set<string>();
      for (let index = 0; index < 12; index += 1) {
        const credentials = await registered(`entropy${index}`);
        const token = tokenIn(t.emails.last(credentials.email, 'verify_email'));
        expect(token).toMatch(TOKEN);
        expect(Buffer.from(token, 'base64url')).toHaveLength(32);
        tokens.add(token);
      }
      expect(tokens.size).toBe(12);
      // Not a counter or a timestamp: the 12 tokens differ in most positions.
      const [first, second] = [...tokens] as [string, string];
      const same = [...first].filter((character, index) => character === second[index]).length;
      expect(same).toBeLessThan(12);
    });

    it('S-AUTH-10: only the SHA-256 of a token is stored; the database never holds the raw token', async () => {
      const credentials = await registered();
      const verify = tokenIn(t.emails.last(credentials.email, 'verify_email'));
      const reset = await resetToken(credentials.email);

      const rows = await tokenRows();
      expect(rows.map((row) => row.token_hash).sort()).toEqual(
        [verify, reset].map((token) => createHash('sha256').update(token).digest('hex')).sort(),
      );
      const dump = await testDb.sql.query<{ dump: string }>(
        `SELECT coalesce(string_agg(row_to_json(t)::text, ' '), '') AS dump FROM one_time_token t`,
      );
      const users = await testDb.sql.query<{ dump: string }>(
        `SELECT coalesce(string_agg(row_to_json(u)::text, ' '), '') AS dump FROM "user" u`,
      );
      for (const token of [verify, reset]) {
        expect(dump.rows[0]?.dump).not.toContain(token);
        expect(users.rows[0]?.dump).not.toContain(token);
      }
    });
  });

  // ── forgot password ──

  describe('POST /v1/auth/password/forgot (FR-AUTH-005, S-AUTH-3)', () => {
    it('FR-AUTH-005 / S-AUTH-3: always 202 with an identical response for verified, unverified, unknown and deleted addresses', async () => {
      const verified = await registered('verified');
      await post('/verify-email', {
        token: tokenIn(t.emails.last(verified.email, 'verify_email')),
      });
      const unverified = await registered('unverified');
      const deleted = await registered('deleted');
      await testDb.sql.query('UPDATE "user" SET deleted_at = now() WHERE email = $1', [
        deleted.email,
      ]);
      t.emails.clear();

      const responses = [];
      for (const email of [
        verified.email,
        unverified.email,
        'nobody@example.test',
        deleted.email,
        verified.email.toUpperCase(),
      ]) {
        responses.push(await forgot(email));
      }

      for (const response of responses) {
        expect(response.status).toBe(202);
        expect(response.body).toEqual({ status: 'accepted' });
        expect(response.headers['cache-control']).toBe('no-store');
        expect(visible(response)).toEqual(visible(responses[0] as request.Response));
      }

      // Behind the identical answers: links only for the live accounts.
      expect(emailsOf(verified.email, 'reset_password')).toHaveLength(2);
      expect(emailsOf(unverified.email, 'reset_password')).toHaveLength(1);
      expect(t.emails.to('nobody@example.test')).toEqual([]);
      expect(t.emails.to(deleted.email)).toEqual([]);
    });

    it('FR-AUTH-005 / S-AUTH-3: the response does not wait for the account lookup, the token or the email', async () => {
      const known = await registered();
      // A provider that never answers, and a database call that has not been made yet when the
      // response is produced: the handler answers first and works afterwards.
      t.emails.hang = true;
      t.emails.clear();
      const logsBefore = t.logs.lines.length;

      const knownResponse = await post('/password/forgot', { email: known.email });
      const unknownResponse = await post('/password/forgot', { email: 'nobody@example.test' });
      expect(knownResponse.status).toBe(202);
      expect(visible(knownResponse)).toEqual(visible(unknownResponse));

      // Both requests were answered by the same code path: the request log shows two completed
      // requests, and the hanging delivery is still pending in the background.
      await expect.poll(() => t.emails.sent.length, { timeout: 5000 }).toBe(1);
      expect(t.auth.background.pending).toBe(1);
      expect(t.logs.lines.length).toBeGreaterThan(logsBefore);
    });

    it('FR-AUTH-005: the reset email carries a one-hour, single-purpose link to the web app', async () => {
      const credentials = await registered();
      await forgot(credentials.email);

      const message = t.emails.last(credentials.email, 'reset_password');
      const token = tokenIn(message);
      expect(token).toMatch(TOKEN);
      expect(message.text).toContain(`http://localhost:5173/reset-password#token=${token}`);
      const row = (await tokenRows()).find((candidate) => candidate.purpose === 'reset_password');
      expect(row).toMatchObject({
        sent_to: credentials.email,
        used_at: null,
        expires_at: new Date(t.clock.now().getTime() + HOUR),
      });
    });

    it('S-AUTH-10: a new reset request invalidates the earlier unused link', async () => {
      const credentials = await registered();
      const first = await resetToken(credentials.email);
      const second = await resetToken(credentials.email);
      expect(second).not.toBe(first);
      expect((await tokenRows()).filter((row) => row.purpose === 'reset_password')).toHaveLength(1);

      const stale = await post('/password/reset', { token: first, newPassword: NEW_PASSWORD });
      expect(stale.status).toBe(400);
      expect(await canLogIn(credentials)).toBe(true);
      expect(
        (await post('/password/reset', { token: second, newPassword: NEW_PASSWORD })).status,
      ).toBe(200);
    });

    it('FR-AUTH-005: at most three reset emails per address per hour, silently; the answer stays 202', async () => {
      const credentials = await registered();
      const responses = [];
      for (let attempt = 0; attempt < 5; attempt += 1) {
        responses.push(await forgot(credentials.email));
      }
      expect(responses.map((response) => response.status)).toEqual([202, 202, 202, 202, 202]);
      expect(emailsOf(credentials.email, 'reset_password')).toHaveLength(3);

      // The link from the last email that went out still works: suppressed requests did not
      // replace its token.
      const delivered = tokenIn(t.emails.last(credentials.email, 'reset_password'));
      t.clock.advance(30 * MINUTE);
      expect(
        (await post('/password/reset', { token: delivered, newPassword: NEW_PASSWORD })).status,
      ).toBe(200);

      t.clock.advance(30 * MINUTE);
      await forgot(credentials.email);
      expect(emailsOf(credentials.email, 'reset_password')).toHaveLength(4);
    });

    it('FR-AUTH-005 / S-AUTH-4: forgot is limited per IP by the /v1/auth budget, the same for known and unknown addresses', async () => {
      t = await buildAuthTestApp({
        db: testDb.db.client,
        env: { API_RATE_LIMIT_AUTH_MAX: '3' },
      });
      const credentials = newCredentials();
      await register(t.app, credentials); // 1 of 3
      const statuses = [];
      for (const email of [credentials.email, 'nobody@example.test', credentials.email]) {
        statuses.push((await forgot(email)).status);
      }
      expect(statuses).toEqual([202, 202, 429]);
      const unknownLimited = await forgot('nobody@example.test');
      expect(unknownLimited.status).toBe(429);
      expect(unknownLimited.headers['retry-after']).toMatch(/^[1-9][0-9]*$/);
      expect(unknownLimited.body).toMatchObject({ code: 'RATE_LIMITED' });
    });

    it('FR-AUTH-005: an invalid body is a validation error, the same for every address', async () => {
      expect((await post('/password/forgot', { email: 'not-an-email' })).status).toBe(422);
      expect((await post('/password/forgot', {})).status).toBe(422);
      expect(
        (await post('/password/forgot', { email: 'a@example.test', userId: 'x' })).status,
      ).toBe(422);
      await t.settle();
      expect(t.emails.sent).toEqual([]);
    });

    it('S-AUTH-7: a browser request from an origin that is not allowed is refused', async () => {
      const response = await post('/password/forgot', { email: 'a@example.test' }).set(
        'Origin',
        'https://evil.example',
      );
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: 'CSRF_REJECTED' });
    });
  });

  // ── reset password ──

  describe('POST /v1/auth/password/reset (FR-AUTH-005, S-AUTH-10)', () => {
    it('FR-AUTH-005 / S-AUTH-10: sets the new password and revokes every session (refresh tokens and access tokens)', async () => {
      const credentials = await registered();
      const web = await loginWeb(t.app, credentials);
      const mobile = await loginMobile(t.app, credentials);
      const bystander = await registered('bystander');
      const bystanderSession = await loginMobile(t.app, bystander);
      const token = await resetToken(credentials.email);
      t.emails.clear();

      const response = await post('/password/reset', { token, newPassword: NEW_PASSWORD }).set(
        WEB_HEADERS,
      );
      await t.settle();

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'password_reset' });
      expect(response.headers['cache-control']).toBe('no-store');
      // No session is handed out by a reset, and the browser's dead cookie is cleared.
      expect(JSON.stringify(response.body)).not.toContain('accessToken');
      expect(setCookieLines(response).join(';')).toMatch(/^akiba_refresh=;/);

      // Old password is gone, new one works.
      expect(await canLogIn(credentials)).toBe(false);
      expect(await canLogIn({ email: credentials.email, password: NEW_PASSWORD })).toBe(true);

      // Every earlier session is dead: both refresh tokens and both access tokens.
      expect((await refreshWeb(t.app, web.refreshToken)).status).toBe(401);
      expect((await refreshMobile(t.app, mobile.refreshToken)).status).toBe(401);
      expect((await getMe(t.app, web.accessToken)).status).toBe(401);
      expect((await getMe(t.app, mobile.accessToken)).status).toBe(401);
      const live = await testDb.sql.query(
        'SELECT 1 FROM refresh_token WHERE user_id = $1 AND revoked_at IS NULL',
        [web.userId],
      );
      // Only the session of the login just above (`canLogIn` with the new password).
      expect(live.rowCount).toBe(1);

      // Someone else's session is untouched.
      expect((await getMe(t.app, bystanderSession.accessToken)).status).toBe(200);

      // S-AUTH-11: the account's address is told.
      expect(t.emails.to(credentials.email).map((message) => message.kind)).toEqual([
        'password_changed',
      ]);
      expect(t.emails.last(credentials.email, 'password_changed').text).not.toContain('token=');
    });

    it('S-AUTH-10: a reset token works once', async () => {
      const credentials = await registered();
      const token = await resetToken(credentials.email);
      expect((await post('/password/reset', { token, newPassword: NEW_PASSWORD })).status).toBe(
        200,
      );

      const again = await post('/password/reset', {
        token,
        newPassword: 'yet another passphrase 9',
      });
      expect(again.status).toBe(400);
      expect(again.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(again.body).toMatchObject(INVALID_TOKEN_PROBLEM);
      expect(await canLogIn({ email: credentials.email, password: NEW_PASSWORD })).toBe(true);
      expect(
        await canLogIn({ email: credentials.email, password: 'yet another passphrase 9' }),
      ).toBe(false);
    });

    it('S-AUTH-10: of two concurrent resets with one token exactly one wins', async () => {
      const credentials = await registered();
      const token = await resetToken(credentials.email);
      const passwords = ['concurrent passphrase A1', 'concurrent passphrase B2'];
      const responses = await Promise.all(
        passwords.map((newPassword) => post('/password/reset', { token, newPassword })),
      );
      expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
      const works = await Promise.all(
        passwords.map((password) => canLogIn({ email: credentials.email, password })),
      );
      expect(works.filter(Boolean)).toHaveLength(1);
      expect(works[responses.findIndex((response) => response.status === 200)]).toBe(true);
    });

    it('S-AUTH-10: a reset token expires after one hour', async () => {
      const early = await registered('early');
      const late = await registered('late');
      const earlyToken = await resetToken(early.email);
      const lateToken = await resetToken(late.email);

      t.clock.advance(HOUR - 1000);
      expect(
        (await post('/password/reset', { token: earlyToken, newPassword: NEW_PASSWORD })).status,
      ).toBe(200);

      t.clock.advance(1000);
      const expired = await post('/password/reset', {
        token: lateToken,
        newPassword: NEW_PASSWORD,
      });
      expect(expired.status).toBe(400);
      expect(expired.body).toMatchObject(INVALID_TOKEN_PROBLEM);
      expect(await canLogIn(late)).toBe(true);
    });

    it('S-AUTH-10: used, expired, unknown, tampered, malformed and wrong-purpose tokens get one identical generic answer and change nothing', async () => {
      const credentials = await registered();
      const verifyToken = tokenIn(t.emails.last(credentials.email, 'verify_email'));

      const usedOwner = await registered('used');
      const used = await resetToken(usedOwner.email);
      await post('/password/reset', { token: used, newPassword: 'the used-up passphrase 3' });

      const expiredOwner = await registered('expired');
      const expired = await resetToken(expiredOwner.email);
      t.clock.advance(HOUR);

      const session = await loginMobile(t.app, credentials);
      const live = await resetToken(credentials.email);
      const cases = {
        used,
        expired,
        unknown: 'B'.repeat(43),
        tampered: live.slice(0, -1) + (live.endsWith('A') ? 'B' : 'A'),
        malformed: '../../etc/passwd',
        wrongPurpose: verifyToken,
      };
      const seen = new Set<string>();
      for (const candidate of Object.values(cases)) {
        const response = await post('/password/reset', {
          token: candidate,
          newPassword: NEW_PASSWORD,
        });
        expect(response.status).toBe(400);
        expect(response.body).toMatchObject(INVALID_TOKEN_PROBLEM);
        seen.add(JSON.stringify(visible(response)));
      }
      expect(seen.size).toBe(1);

      // Nothing changed for the account: password, session, and the still-valid tokens.
      expect(await canLogIn(credentials)).toBe(true);
      expect((await getMe(t.app, session.accessToken)).status).toBe(200);
      expect((await post('/verify-email', { token: verifyToken })).status).toBe(200);
      expect(
        (await post('/password/reset', { token: live, newPassword: NEW_PASSWORD })).status,
      ).toBe(200);
    });

    it('S-AUTH-3: a wrong token costs the same password hashing as a right one', async () => {
      const credentials = await registered();
      const token = await resetToken(credentials.email);
      const before = t.hasher.hashed.length;
      await post('/password/reset', { token: 'C'.repeat(43), newPassword: NEW_PASSWORD });
      expect(t.hasher.hashed.length).toBe(before + 1);
      await post('/password/reset', { token, newPassword: NEW_PASSWORD });
      expect(t.hasher.hashed.length).toBe(before + 2);
    });

    it('S-AUTH-2 / FR-AUTH-005: the password policy applies on reset and a refused password does not use up the link', async () => {
      const credentials = await registered();
      const token = await resetToken(credentials.email);

      const short = await post('/password/reset', { token, newPassword: 'too short' });
      expect(short.status).toBe(422);
      expect(short.body).toMatchObject({
        code: 'VALIDATION_ERROR',
        errors: [{ path: 'newPassword', message: 'must be at least 10 characters' }],
      });
      const long = await post('/password/reset', { token, newPassword: 'x'.repeat(129) });
      expect(long.status).toBe(422);
      const extra = await post('/password/reset', {
        token,
        newPassword: NEW_PASSWORD,
        email: credentials.email,
      });
      expect(extra.status).toBe(422);

      expect(await canLogIn(credentials)).toBe(true);
      expect((await post('/password/reset', { token, newPassword: NEW_PASSWORD })).status).toBe(
        200,
      );
    });

    it('S-AUTH-2 / FR-AUTH-005: a breached password is refused on reset and the link stays usable', async () => {
      const credentials = await registered();
      const token = await resetToken(credentials.email);

      const breached = await post('/password/reset', { token, newPassword: 'Password123' });
      expect(breached.status).toBe(422);
      expect(breached.body).toMatchObject({
        code: 'VALIDATION_ERROR',
        errors: [
          {
            path: 'newPassword',
            message: 'is too common or has appeared in a data breach; choose a different one',
          },
        ],
      });
      expect(await canLogIn(credentials)).toBe(true);
      // The same answer without a valid token: the check does not depend on the token.
      const noToken = await post('/password/reset', {
        token: 'D'.repeat(43),
        newPassword: 'Password123',
      });
      expect(noToken.status).toBe(422);

      expect((await post('/password/reset', { token, newPassword: NEW_PASSWORD })).status).toBe(
        200,
      );
    });

    it('FR-AUTH-006 / S-AUTH-10: a reset proves control of the mailbox, so it verifies an unverified address', async () => {
      const credentials = await registered();
      const verifyToken = tokenIn(t.emails.last(credentials.email, 'verify_email'));
      expect((await userRow(credentials.email)).email_verified_at).toBeNull();
      const token = await resetToken(credentials.email);
      t.clock.advance(MINUTE);

      expect((await post('/password/reset', { token, newPassword: NEW_PASSWORD })).status).toBe(
        200,
      );
      expect((await userRow(credentials.email)).email_verified_at).toEqual(t.clock.now());
      // Every other emailed link of the account is gone with it.
      expect(await tokenRows()).toEqual([]);
      expect((await post('/verify-email', { token: verifyToken })).status).toBe(400);
    });

    it('S-AUTH-10: a reset keeps an earlier verification date and does not verify an address the link was not sent to', async () => {
      const verified = await registered('verified');
      await post('/verify-email', {
        token: tokenIn(t.emails.last(verified.email, 'verify_email')),
      });
      const verifiedAt = (await userRow(verified.email)).email_verified_at;
      t.clock.advance(MINUTE);
      await post('/password/reset', {
        token: await resetToken(verified.email),
        newPassword: NEW_PASSWORD,
      });
      expect((await userRow(verified.email)).email_verified_at).toEqual(verifiedAt);

      const moved = await registered('moved');
      const token = await resetToken(moved.email);
      await testDb.sql.query('UPDATE "user" SET email = $2 WHERE email = $1', [
        moved.email,
        'elsewhere@example.test',
      ]);
      expect(
        (await post('/password/reset', { token, newPassword: 'moved account passphrase 4' }))
          .status,
      ).toBe(200);
      expect((await userRow('elsewhere@example.test')).email_verified_at).toBeNull();
    });

    it('S-AUTH-10: the reset link of an account in deletion does nothing', async () => {
      const credentials = await registered();
      const token = await resetToken(credentials.email);
      const before = (await userRow(credentials.email)).password_hash;
      await testDb.sql.query('UPDATE "user" SET deleted_at = now() WHERE email = $1', [
        credentials.email,
      ]);
      const response = await post('/password/reset', { token, newPassword: NEW_PASSWORD });
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject(INVALID_TOKEN_PROBLEM);
      expect((await userRow(credentials.email)).password_hash).toBe(before);
    });

    it('S-AUTH-4: a successful reset clears the login backoff built up by wrong guesses', async () => {
      const credentials = await registered();
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await post('/login', { email: credentials.email, password: 'wrong guess here' });
      }
      expect((await post('/login', credentials)).status).toBe(429);
      const token = await resetToken(credentials.email);
      await post('/password/reset', { token, newPassword: NEW_PASSWORD });
      expect(await canLogIn({ email: credentials.email, password: NEW_PASSWORD })).toBe(true);
    });
  });

  // ── change password ──

  describe('POST /v1/auth/password/change (S-AUTH-11)', () => {
    it('S-AUTH-11: needs a valid access token', async () => {
      const response = await post('/password/change', {
        currentPassword: 'whatever it was',
        newPassword: NEW_PASSWORD,
      });
      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({ code: 'UNAUTHENTICATED' });
    });

    it('S-AUTH-11: changes the password with the current one, signs out the other sessions, keeps this one, and notifies by email', async () => {
      const credentials = await registered();
      const current = await loginMobile(t.app, credentials);
      const other = await loginWeb(t.app, credentials);
      const staleReset = await resetToken(credentials.email);
      const bystander = await registered('bystander');
      const bystanderSession = await loginMobile(t.app, bystander);
      t.emails.clear();

      const response = await authed('/password/change', current.accessToken, {
        currentPassword: credentials.password,
        newPassword: NEW_PASSWORD,
      });
      await t.settle();

      expect(response.status).toBe(204);
      expect(response.text).toBe('');

      expect(await canLogIn(credentials)).toBe(false);
      expect(await canLogIn({ email: credentials.email, password: NEW_PASSWORD })).toBe(true);

      // The other session is over; the one that made the change lives on.
      expect((await getMe(t.app, other.accessToken)).status).toBe(401);
      expect((await refreshWeb(t.app, other.refreshToken)).status).toBe(401);
      expect((await getMe(t.app, current.accessToken)).status).toBe(200);
      expect((await refreshMobile(t.app, current.refreshToken)).status).toBe(200);
      expect((await getMe(t.app, bystanderSession.accessToken)).status).toBe(200);

      // A reset link requested before the change cannot undo it.
      const undo = await post('/password/reset', {
        token: staleReset,
        newPassword: 'attacker chosen passphrase',
      });
      expect(undo.status).toBe(400);

      expect(t.emails.to(credentials.email).map((message) => message.kind)).toEqual([
        'password_changed',
      ]);
    });

    it('S-AUTH-11: a wrong current password is refused with 403 and changes nothing', async () => {
      const credentials = await registered();
      const session = await loginMobile(t.app, credentials);
      const other = await loginMobile(t.app, credentials);
      t.emails.clear();

      const response = await authed('/password/change', session.accessToken, {
        currentPassword: 'not the current password',
        newPassword: NEW_PASSWORD,
      });
      await t.settle();

      expect(response.status).toBe(403);
      expect(response.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(response.body).toMatchObject({
        type: '/errors/reauthentication-failed',
        code: 'REAUTHENTICATION_FAILED',
      });
      expect(await canLogIn(credentials)).toBe(true);
      expect(await canLogIn({ email: credentials.email, password: NEW_PASSWORD })).toBe(false);
      expect((await getMe(t.app, other.accessToken)).status).toBe(200);
      expect(t.emails.sent).toEqual([]);
    });

    it('S-AUTH-11: the user is taken from the token; a body cannot name another account', async () => {
      const attacker = await registered('attacker');
      const victim = await registered('victim');
      const session = await loginMobile(t.app, attacker);

      const response = await authed('/password/change', session.accessToken, {
        currentPassword: attacker.password,
        newPassword: NEW_PASSWORD,
        userId: (await userRow(victim.email)).id,
        email: victim.email,
      });
      expect(response.status).toBe(422);
      expect(await canLogIn(victim)).toBe(true);
      expect(await canLogIn(attacker)).toBe(true);
    });

    it('S-AUTH-2 / S-AUTH-11: the new password must pass the policy, not be breached, and differ from the current one', async () => {
      const credentials = await registered();
      const session = await loginMobile(t.app, credentials);
      const change = (newPassword: string) =>
        authed('/password/change', session.accessToken, {
          currentPassword: credentials.password,
          newPassword,
        });

      const short = await change('too short');
      expect(short.status).toBe(422);
      expect(short.body).toMatchObject({ errors: [{ path: 'newPassword' }] });

      const breached = await change('Password123');
      expect(breached.status).toBe(422);
      expect(breached.body).toMatchObject({
        errors: [
          {
            path: 'newPassword',
            message: 'is too common or has appeared in a data breach; choose a different one',
          },
        ],
      });

      const same = await change(credentials.password);
      expect(same.status).toBe(422);
      expect(same.body).toMatchObject({
        errors: [{ path: 'newPassword', message: 'must be different from the current password' }],
      });

      expect(await canLogIn(credentials)).toBe(true);
    });

    it('S-AUTH-4 / S-AUTH-11: guessing the current password is throttled like login guesses', async () => {
      const credentials = await registered();
      const session = await loginMobile(t.app, credentials);
      const statuses = [];
      for (let attempt = 0; attempt < 7; attempt += 1) {
        const response = await authed('/password/change', session.accessToken, {
          currentPassword: `wrong guess number ${attempt}`,
          newPassword: NEW_PASSWORD,
        });
        statuses.push(response.status);
      }
      expect(statuses.slice(0, 5)).toEqual([403, 403, 403, 403, 403]);
      expect(statuses).toContain(429);
      // Even the right password has to wait now.
      const blocked = await authed('/password/change', session.accessToken, {
        currentPassword: credentials.password,
        newPassword: NEW_PASSWORD,
      });
      expect(blocked.status).toBe(429);
      expect(blocked.headers['retry-after']).toMatch(/^[1-9][0-9]*$/);
      expect(await canLogIn({ email: credentials.email, password: NEW_PASSWORD })).toBe(false);
    });

    it('S-AUTH-11: an account without a password (OAuth-only) cannot use change; it sets one through reset', async () => {
      const credentials = await registered();
      const session = await loginMobile(t.app, credentials);
      await testDb.sql.query('UPDATE "user" SET password_hash = NULL WHERE email = $1', [
        credentials.email,
      ]);
      const verifications = t.hasher.verifiedAgainst.length;
      const response = await authed('/password/change', session.accessToken, {
        currentPassword: credentials.password,
        newPassword: NEW_PASSWORD,
      });
      expect(response.status).toBe(403);
      // Still exactly one verification, against the dummy hash.
      expect(t.hasher.verifiedAgainst.slice(verifications)).toEqual([t.hasher.dummyHash]);

      const token = await resetToken(credentials.email);
      expect((await post('/password/reset', { token, newPassword: NEW_PASSWORD })).status).toBe(
        200,
      );
      expect(await canLogIn({ email: credentials.email, password: NEW_PASSWORD })).toBe(true);
    });
  });

  // ── verified-email gate for later features ──

  describe('verified-email gate (Q-04)', () => {
    it('Q-04 / FR-AUTH-006: the gate for later features answers 403 EMAIL_NOT_VERIFIED until the address is verified', async () => {
      const router = Router();
      router.use(t.auth.router);
      router.get('/needs-verified', ...t.auth.authenticated, t.auth.verifiedEmail, (_req, res) => {
        res.status(200).json({ ok: true });
      });
      const app = createApp({
        config: t.config,
        logger: createLogger({ level: 'silent', destination: new LogSink() }),
        v1Router: router,
      });

      const credentials = await registered();
      const session = await loginMobile(app, credentials);
      const get = () =>
        request(app)
          .get('/v1/needs-verified')
          .set('Authorization', `Bearer ${session.accessToken}`);

      expect((await request(app).get('/v1/needs-verified')).status).toBe(401);
      const refused = await get();
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({
        type: '/errors/email-not-verified',
        code: 'EMAIL_NOT_VERIFIED',
      });

      await post('/verify-email', {
        token: tokenIn(t.emails.last(credentials.email, 'verify_email')),
      });
      expect((await get()).status).toBe(200);
    });
  });

  // ── nothing secret in the logs ──

  describe('logs (doc 09 §7, S-AUTH-10)', () => {
    it('S-AUTH-10: a full verify, forgot, reset and change run logs no token, link, password or email address', async () => {
      const credentials = await registered();
      const verifyToken = tokenIn(t.emails.last(credentials.email, 'verify_email'));
      await post('/verify-email', { token: verifyToken });
      await post('/verify-email', { token: verifyToken });
      const session = await loginMobile(t.app, credentials);
      await authed('/verify-email/resend', session.accessToken);
      await forgot('nobody@example.test');
      const reset = await resetToken(credentials.email);
      await post('/password/reset', { token: 'E'.repeat(43), newPassword: NEW_PASSWORD });
      await post('/password/reset', { token: reset, newPassword: NEW_PASSWORD });
      const again = await loginMobile(t.app, { email: credentials.email, password: NEW_PASSWORD });
      await authed('/password/change', again.accessToken, {
        currentPassword: NEW_PASSWORD,
        newPassword: 'the third passphrase 11',
      });
      await t.settle();

      const logs = t.logs.text;
      expect(t.logs.lines.length).toBeGreaterThan(10);
      for (const secret of [
        verifyToken,
        reset,
        'E'.repeat(43),
        ...t.emails.sent.filter((m) => m.text.includes('#token=')).map(tokenIn),
        credentials.email,
        'nobody@example.test',
        credentials.password,
        NEW_PASSWORD,
        'the third passphrase 11',
        'token=',
        '/verify-email#',
        '/reset-password#',
      ]) {
        expect(logs).not.toContain(secret);
      }
      // The events themselves are there, identified by user ID only.
      const events = t.logs.lines.map((line) => line['event']);
      for (const event of [
        'verify_email',
        'verify_email_failed',
        'password_reset_request',
        'password_reset_failed',
        'password_reset',
        'password_change',
      ]) {
        expect(events).toContain(event);
      }
    });
  });
});
