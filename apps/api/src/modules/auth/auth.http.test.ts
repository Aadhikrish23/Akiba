import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildAuthTestApp,
  cookieHeader,
  getMe,
  loginMobile,
  loginWeb,
  MINUTE,
  MOBILE_HEADERS,
  newCredentials,
  refreshCookieValue,
  refreshWeb,
  register,
  SECOND,
  setCookieLines,
  WEB_HEADERS,
  WEB_ORIGIN,
  type AuthTestApp,
} from '../../testing/auth.js';
import { createTestDatabase, type TestDatabase } from '../../testing/database.js';

const PROBLEM_JSON = /^application\/problem\+json/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const REFRESH_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** A problem body with the per-request ID removed, for comparing two responses. */
function comparable(response: request.Response): Record<string, unknown> {
  const { requestId, ...rest } = response.body as Record<string, unknown>;
  expect(requestId).toEqual(expect.any(String));
  return rest;
}

describe('auth over HTTP: register, login, transport', () => {
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

  const userRow = async (email: string) => {
    const result = await testDb.sql.query<{
      id: string;
      email: string;
      password_hash: string | null;
      display_name: string | null;
      email_verified_at: Date | null;
    }>(
      'SELECT id, email, password_hash, display_name, email_verified_at FROM "user" WHERE email = $1',
      [email],
    );
    return result.rows;
  };

  describe('POST /v1/auth/register (FR-AUTH-001)', () => {
    it('FR-AUTH-001: creates the account and answers 201 without tokens', async () => {
      const credentials = newCredentials();
      const response = await request(t.app)
        .post('/v1/auth/register')
        .send({ ...credentials, displayName: '  Ada Lovelace ' });

      expect(response.status).toBe(201);
      expect(response.body).toEqual({ status: 'verification_pending' });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(setCookieLines(response)).toEqual([]);

      const rows = await userRow(credentials.email);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        email: credentials.email,
        display_name: 'Ada Lovelace',
        email_verified_at: null,
      });
    });

    it('S-AUTH-1 / NFR-SEC-001: stores an argon2id hash, never the password', async () => {
      const credentials = newCredentials();
      await register(t.app, credentials);
      const [row] = await userRow(credentials.email);
      expect(row?.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
      const dump = await testDb.sql.query<{ row: string }>(
        'SELECT row_to_json(u)::text AS row FROM "user" u',
      );
      expect(dump.rows.map((r) => r.row).join('\n')).not.toContain(credentials.password);
    });

    it('S-AUTH-3: an existing email gets the identical response and the account is untouched', async () => {
      const credentials = newCredentials();
      const first = await request(t.app)
        .post('/v1/auth/register')
        .send({ ...credentials, displayName: 'Owner' });
      const [before] = await userRow(credentials.email);

      const second = await request(t.app).post('/v1/auth/register').send({
        email: credentials.email,
        password: 'an attacker chosen pw',
        displayName: 'Mallory',
      });

      expect(second.status).toBe(first.status);
      expect(second.body).toEqual(first.body);
      expect(Object.keys(second.headers).sort()).toEqual(Object.keys(first.headers).sort());
      const rows = await userRow(credentials.email);
      expect(rows).toEqual([before]);
      // Same work on both paths: one password hash each.
      expect(t.hasher.passwordHashes).toHaveLength(2);

      // The attacker's password does not work; the owner's still does.
      const attacker = await request(t.app)
        .post('/v1/auth/login')
        .send({ email: credentials.email, password: 'an attacker chosen pw' });
      expect(attacker.status).toBe(401);
      await loginWeb(t.app, credentials);
    });

    it('S-AUTH-3: email uniqueness ignores case', async () => {
      const credentials = newCredentials();
      await register(t.app, credentials);
      const response = await request(t.app).post('/v1/auth/register').send({
        email: credentials.email.toUpperCase(),
        password: 'another long password',
        displayName: 'X',
      });
      expect(response.status).toBe(201);
      const count = await testDb.sql.query('SELECT 1 FROM "user"');
      expect(count.rowCount).toBe(1);
    });

    it.each([
      ['a 9-character password', { password: '123456789' }, 'password'],
      ['a 129-character password', { password: 'a'.repeat(129) }, 'password'],
      ['an invalid email', { email: 'not-an-email' }, 'email'],
      ['an over-long email', { email: `${'a'.repeat(250)}@example.test` }, 'email'],
      ['an empty display name', { displayName: '   ' }, 'displayName'],
      ['a 51-character display name', { displayName: 'd'.repeat(51) }, 'displayName'],
      ['a non-string password', { password: 1234567890 }, 'password'],
    ])('S-AUTH-2: rejects %s with 422', async (_label, override, path) => {
      const response = await request(t.app)
        .post('/v1/auth/register')
        .send({ ...newCredentials(), displayName: 'Ada', ...override });
      expect(response.status).toBe(422);
      expect(response.headers['content-type']).toMatch(PROBLEM_JSON);
      const body = response.body as { code: string; errors: { path: string }[] };
      expect(body.code).toBe('VALIDATION_ERROR');
      expect(body.errors.map((error) => error.path)).toEqual([path]);
      expect((await testDb.sql.query('SELECT 1 FROM "user"')).rowCount).toBe(0);
    });

    it('S-AUTH-2: rejects unknown fields and a missing body (doc 09 §4)', async () => {
      const extra = await request(t.app)
        .post('/v1/auth/register')
        .send({ ...newCredentials(), displayName: 'Ada', isAdmin: true });
      expect(extra.status).toBe(422);
      const empty = await request(t.app).post('/v1/auth/register');
      expect(empty.status).toBe(422);
      const form = await request(t.app)
        .post('/v1/auth/register')
        .type('form')
        .send('email=a@example.test&password=correct+horse+battery&displayName=A');
      expect(form.status).toBe(422);
      expect((await testDb.sql.query('SELECT 1 FROM "user"')).rowCount).toBe(0);
    });

    it('S-AUTH-2: accepts 10 and 128 characters, spaces and Unicode, with no composition rules', async () => {
      for (const password of [
        'zq'.repeat(5),
        'k'.repeat(128),
        'only lowercase letters',
        'пароль для аниме 😀',
      ]) {
        const credentials = { email: newCredentials().email, password };
        await register(t.app, credentials);
        await loginWeb(t.app, credentials);
      }
    });

    it('S-AUTH-2: rejects a breached password with 422 and does not create the account', async () => {
      for (const password of ['password123', 'QWERTYUIOP', '1234567890']) {
        const credentials = { email: newCredentials().email, password };
        const response = await request(t.app)
          .post('/v1/auth/register')
          .send({ ...credentials, displayName: 'Ada' });
        expect(response.status).toBe(422);
        const body = response.body as { errors: { path: string; message: string }[] };
        expect(body.errors).toEqual([
          { path: 'password', message: expect.stringContaining('breach') as string },
        ]);
        expect(await userRow(credentials.email)).toHaveLength(0);
      }
      expect(t.hasher.passwordHashes).toHaveLength(0);
    });

    it('S-AUTH-2: uses the injected BreachedPasswordChecker (interface seam)', async () => {
      const seen: string[] = [];
      const custom = await buildAuthTestApp({
        db: testDb.db.client,
        breachedPasswords: {
          isBreached: (password) => {
            seen.push(password);
            return Promise.resolve(password === 'flagged by the checker');
          },
        },
      });
      const flagged = await request(custom.app).post('/v1/auth/register').send({
        email: newCredentials().email,
        password: 'flagged by the checker',
        displayName: 'A',
      });
      expect(flagged.status).toBe(422);
      // The default list would have refused this one; the injected checker decides instead.
      const allowed = await request(custom.app)
        .post('/v1/auth/register')
        .send({ email: newCredentials().email, password: 'password123', displayName: 'A' });
      expect(allowed.status).toBe(201);
      expect(seen).toEqual(['flagged by the checker', 'password123']);
    });
  });

  describe('POST /v1/auth/login (FR-AUTH-001, FR-AUTH-003)', () => {
    it('FR-AUTH-003: web login returns an access token and user, and sets the refresh cookie', async () => {
      const credentials = newCredentials();
      await register(t.app, credentials);
      const response = await request(t.app)
        .post('/v1/auth/login')
        .set(WEB_HEADERS)
        .send(credentials);

      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const body = response.body as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['accessToken', 'expiresIn', 'tokenType', 'user']);
      expect(body).toMatchObject({
        accessToken: expect.stringMatching(JWT) as string,
        tokenType: 'Bearer',
        expiresIn: 900,
        user: {
          id: expect.stringMatching(UUID) as string,
          email: credentials.email,
          displayName: 'Test User',
          emailVerified: false,
        },
      });
      // S-AUTH-7: the refresh token is NOT in the body for a browser.
      expect(JSON.stringify(body)).not.toContain(refreshCookieValue(response));
      expect(refreshCookieValue(response)).toMatch(REFRESH_TOKEN);
    });

    it('S-AUTH-7: the refresh cookie is HttpOnly; Secure; SameSite=Lax; Path=/v1/auth; Max-Age=14 days', async () => {
      const credentials = newCredentials();
      await register(t.app, credentials);
      const response = await request(t.app)
        .post('/v1/auth/login')
        .set(WEB_HEADERS)
        .send(credentials);
      const lines = setCookieLines(response);
      expect(lines).toHaveLength(1);
      const attributes = (lines[0] ?? '').split('; ');
      expect(attributes[0]).toMatch(/^akiba_refresh=[A-Za-z0-9_-]{43}$/);
      const rest = attributes.slice(1);
      expect(rest.filter((attribute) => attribute.startsWith('Expires=')).length).toBe(1);
      expect(rest.filter((attribute) => !attribute.startsWith('Expires=')).sort()).toEqual([
        'HttpOnly',
        'Max-Age=1209600',
        'Path=/v1/auth',
        'SameSite=Lax',
        'Secure',
      ]);
      expect(lines[0]).not.toMatch(/Domain=/i);
    });

    it('S-AUTH-7: cookie flags per environment: Secure can be dropped in development and test only', async () => {
      const credentials = newCredentials();
      await register(t.app, credentials);
      const insecure = await buildAuthTestApp({
        db: testDb.db.client,
        env: { NODE_ENV: 'development', AUTH_COOKIE_SECURE: 'false' },
      });
      const response = await request(insecure.app)
        .post('/v1/auth/login')
        .set(WEB_HEADERS)
        .send(credentials);
      const [line] = setCookieLines(response);
      expect(line).toMatch(/; HttpOnly/);
      expect(line).toMatch(/; SameSite=Lax/);
      expect(line).toMatch(/; Path=\/v1\/auth/);
      expect(line).not.toMatch(/Secure/);

      // Default in every environment is Secure; production cannot turn it off (see env.test.ts).
      for (const nodeEnv of ['development', 'test']) {
        const secure = await buildAuthTestApp({ db: testDb.db.client, env: { NODE_ENV: nodeEnv } });
        const login = await request(secure.app)
          .post('/v1/auth/login')
          .set(WEB_HEADERS)
          .send(credentials);
        expect(setCookieLines(login)[0]).toMatch(/; Secure/);
      }
    });

    it('S-AUTH-8: mobile login (X-Client: mobile) returns the refresh token in the body and sets no cookie', async () => {
      const credentials = newCredentials();
      await register(t.app, credentials);
      const response = await request(t.app)
        .post('/v1/auth/login')
        .set(MOBILE_HEADERS)
        .send(credentials);
      expect(response.status).toBe(200);
      expect(setCookieLines(response)).toEqual([]);
      const body = response.body as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual([
        'accessToken',
        'expiresIn',
        'refreshToken',
        'tokenType',
        'user',
      ]);
      expect(body['refreshToken']).toMatch(REFRESH_TOKEN);
    });

    it('S-AUTH-6: stores only the SHA-256 of the refresh token, with family and both deadlines', async () => {
      const credentials = newCredentials();
      await register(t.app, credentials);
      const session = await loginMobile(t.app, credentials);
      const rows = await testDb.sql.query<{
        token_hash: string;
        family_id: string;
        expires_at: Date;
        family_expires_at: Date;
        revoked_at: Date | null;
        user_agent: string | null;
      }>('SELECT * FROM refresh_token');
      expect(rows.rows).toHaveLength(1);
      const row = rows.rows[0];
      expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row?.token_hash).not.toBe(session.refreshToken);
      const dump = await testDb.sql.query<{ row: string }>(
        'SELECT row_to_json(r)::text AS row FROM refresh_token r',
      );
      expect(dump.rows[0]?.row).not.toContain(session.refreshToken);
      const now = t.clock.now().getTime();
      expect(row?.expires_at.getTime()).toBe(now + 14 * 24 * 60 * MINUTE);
      expect(row?.family_expires_at.getTime()).toBe(now + 30 * 24 * 60 * MINUTE);
      expect(row?.revoked_at).toBeNull();
      // 256 bits of randomness: 43 base64url characters, different every time.
      const second = await loginMobile(t.app, credentials);
      expect(second.refreshToken).not.toBe(session.refreshToken);
    });

    it('FR-AUTH-001: email is matched case-insensitively at login', async () => {
      const credentials = newCredentials();
      await register(t.app, credentials);
      const response = await request(t.app)
        .post('/v1/auth/login')
        .send({ email: credentials.email.toUpperCase(), password: credentials.password });
      expect(response.status).toBe(200);
    });

    it('S-AUTH-3: unknown email and wrong password are indistinguishable (status, headers, body)', async () => {
      const credentials = newCredentials();
      await register(t.app, credentials);

      const wrongPassword = await request(t.app)
        .post('/v1/auth/login')
        .set(WEB_HEADERS)
        .send({ email: credentials.email, password: 'definitely not the one' });
      const unknownEmail = await request(t.app)
        .post('/v1/auth/login')
        .set(WEB_HEADERS)
        .send({ email: 'nobody@example.test', password: 'definitely not the one' });

      for (const response of [wrongPassword, unknownEmail]) {
        expect(response.status).toBe(401);
        expect(response.headers['content-type']).toMatch(PROBLEM_JSON);
        expect(setCookieLines(response)).toEqual([]);
      }
      expect(comparable(unknownEmail)).toEqual(comparable(wrongPassword));
      expect(comparable(wrongPassword)).toEqual({
        type: '/errors/invalid-credentials',
        title: 'Invalid credentials',
        status: 401,
        code: 'INVALID_CREDENTIALS',
        detail: 'The email or password is incorrect.',
      });
      const variable = new Set([
        'x-request-id',
        'date',
        'etag',
        'content-length',
        'ratelimit-reset',
      ]);
      const stable = (response: request.Response) =>
        Object.fromEntries(
          Object.entries(response.headers).filter(([name]) => !variable.has(name)),
        );
      expect(stable(unknownEmail)).toEqual({
        ...stable(wrongPassword),
        'ratelimit-remaining': stable(unknownEmail)['ratelimit-remaining'],
      });
      expect(unknownEmail.headers['content-length']).toBe(wrongPassword.headers['content-length']);
    });

    it('S-AUTH-3: the dummy-hash path is taken: exactly one argon2 verification in every failure case', async () => {
      const credentials = newCredentials();
      await register(t.app, credentials);
      const realHash = t.hasher.passwordHashes[0];
      expect(realHash).toBeDefined();
      // An account with no password (OAuth-only) and one in its deletion grace period.
      await testDb.sql.query(`INSERT INTO "user" (email) VALUES ('oauth-only@example.test')`);
      const deleted = newCredentials('deleted');
      await register(t.app, deleted);
      await testDb.sql.query(`UPDATE "user" SET deleted_at = now() WHERE email = $1`, [
        deleted.email,
      ]);
      const deletedHash = t.hasher.passwordHashes[1];

      const attempt = async (email: string, password: string) => {
        const before = t.hasher.verifiedAgainst.length;
        const response = await request(t.app).post('/v1/auth/login').send({ email, password });
        expect(t.hasher.verifiedAgainst.length - before).toBe(1);
        return { response, against: t.hasher.verifiedAgainst.at(-1) };
      };

      const wrong = await attempt(credentials.email, 'definitely not the one');
      expect(wrong.response.status).toBe(401);
      expect(wrong.against).toBe(realHash);

      const unknown = await attempt('nobody@example.test', 'definitely not the one');
      const oauthOnly = await attempt('oauth-only@example.test', 'definitely not the one');
      const inDeletion = await attempt(deleted.email, deleted.password);
      const dummy = unknown.against;
      // The dummy is a real argon2id hash with the production parameters, and nobody's hash.
      expect(dummy).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
      expect(dummy).toBe(t.hasher.dummyHash);
      expect(t.hasher.passwordHashes).not.toContain(dummy);
      expect([realHash, deletedHash]).not.toContain(dummy);
      for (const result of [unknown, oauthOnly, inDeletion]) {
        expect(result.response.status).toBe(401);
        expect(result.against).toBe(dummy);
        expect(comparable(result.response)).toEqual(comparable(wrong.response));
      }
      // No session was created by any of them.
      expect((await testDb.sql.query('SELECT 1 FROM refresh_token')).rowCount).toBe(0);
    });

    it('S-AUTH-2: login does not apply the password policy (no hint about the stored password)', async () => {
      const response = await request(t.app)
        .post('/v1/auth/login')
        .send({ email: 'nobody@example.test', password: 'short' });
      expect(response.status).toBe(401);
      const tooLong = await request(t.app)
        .post('/v1/auth/login')
        .send({ email: 'nobody@example.test', password: 'p'.repeat(1025) });
      expect(tooLong.status).toBe(422);
    });

    it('S-AUTH-2: rejects unknown fields and malformed input with 422, never reaching the hasher', async () => {
      for (const body of [
        {},
        { email: 'a@example.test' },
        { email: 'x', password: 'y' },
        { email: 'a@example.test', password: 'pw', remember: true },
      ]) {
        const response = await request(t.app).post('/v1/auth/login').send(body);
        expect(response.status).toBe(422);
      }
      expect(t.hasher.verifiedAgainst).toHaveLength(0);
    });
  });

  describe('GET /v1/me (auth middleware)', () => {
    it('FR-AUTH-003: returns the caller identified by the access token', async () => {
      const credentials = newCredentials();
      await register(t.app, credentials);
      const session = await loginWeb(t.app, credentials);
      const response = await getMe(t.app, session.accessToken);
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      // Identity plus the settings of T17, with their defaults.
      expect(response.body).toEqual({
        id: session.userId,
        email: credentials.email,
        displayName: 'Test User',
        emailVerified: false,
        titleLanguage: 'romaji',
        timeZone: 'UTC',
        libraryView: 'grid',
        alertsEnabled: true,
        showAdult: false,
        createdAt: expect.any(String) as string,
      });
    });

    it.each([
      ['no Authorization header', undefined],
      ['an empty bearer', 'Bearer '],
      ['a non-bearer scheme', 'Basic dXNlcjpwYXNz'],
      ['a lower-case scheme with garbage', 'bearer abc'],
      ['two tokens', 'Bearer abc def'],
      ['garbage', 'Bearer not.a.jwt'],
      ['an over-long token', `Bearer ${'a'.repeat(5000)}`],
    ])('S-AUTH-5: %s is 401 with WWW-Authenticate: Bearer', async (_label, header) => {
      const pending = request(t.app).get('/v1/me');
      const response = await (header === undefined
        ? pending
        : pending.set('Authorization', header));
      expect(response.status).toBe(401);
      expect(response.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(response.headers['www-authenticate']).toBe('Bearer');
      expect((response.body as { code: string }).code).toBe('UNAUTHENTICATED');
    });

    it('S-AUTH-7: the refresh cookie alone never authenticates an API request', async () => {
      const credentials = newCredentials();
      await register(t.app, credentials);
      const session = await loginWeb(t.app, credentials);
      const response = await request(t.app)
        .get('/v1/me')
        .set(WEB_HEADERS)
        .set('Cookie', cookieHeader(session.refreshToken));
      expect(response.status).toBe(401);
      // Nor does a refresh token presented as a bearer token.
      expect((await getMe(t.app, session.refreshToken)).status).toBe(401);
    });
  });

  describe('CSRF defence for the cookie transport (S-AUTH-7)', () => {
    let refreshToken: string;

    beforeEach(async () => {
      const credentials = newCredentials();
      await register(t.app, credentials);
      refreshToken = (await loginWeb(t.app, credentials)).refreshToken;
    });

    const stillAlive = async () => {
      const rows = await testDb.sql.query('SELECT 1 FROM refresh_token WHERE revoked_at IS NULL');
      expect(rows.rowCount).toBe(1);
    };

    it.each(['/v1/auth/refresh', '/v1/auth/logout'])(
      'S-AUTH-7: %s with the cookie but no X-Client header is 403 and changes nothing',
      async (path) => {
        const response = await request(t.app)
          .post(path)
          .set('Origin', WEB_ORIGIN)
          .set('Cookie', cookieHeader(refreshToken));
        expect(response.status).toBe(403);
        expect(response.headers['content-type']).toMatch(PROBLEM_JSON);
        expect((response.body as { code: string }).code).toBe('CSRF_REJECTED');
        expect(setCookieLines(response)).toEqual([]);
        await stillAlive();
      },
    );

    it.each(['/v1/auth/refresh', '/v1/auth/logout'])(
      'S-AUTH-7: %s from an origin that is not allow-listed is 403 and changes nothing',
      async (path) => {
        for (const origin of [
          'https://evil.example',
          'https://app.akiba.test.evil.example',
          'null',
          'http://app.akiba.test',
        ]) {
          const response = await request(t.app)
            .post(path)
            .set('Origin', origin)
            .set('X-Client', 'web/1.0.0')
            .set('Cookie', cookieHeader(refreshToken));
          expect(response.status).toBe(403);
          expect(response.headers['access-control-allow-origin']).toBeUndefined();
        }
        await stillAlive();
      },
    );

    it.each(['/v1/auth/refresh', '/v1/auth/logout'])(
      'S-AUTH-7: %s with neither Origin nor Referer is 403; an allow-listed Referer is accepted as fallback',
      async (path) => {
        const neither = await request(t.app)
          .post(path)
          .set('X-Client', 'web/1.0.0')
          .set('Cookie', cookieHeader(refreshToken));
        expect(neither.status).toBe(403);
        const badReferer = await request(t.app)
          .post(path)
          .set('X-Client', 'web/1.0.0')
          .set('Referer', 'https://evil.example/app.akiba.test')
          .set('Cookie', cookieHeader(refreshToken));
        expect(badReferer.status).toBe(403);
        await stillAlive();

        const goodReferer = await request(t.app)
          .post(path)
          .set('X-Client', 'web/1.0.0')
          .set('Referer', `${WEB_ORIGIN}/library?tab=watching`)
          .set('Cookie', cookieHeader(refreshToken));
        expect(goodReferer.status).toBeLessThan(300);
      },
    );

    it('S-AUTH-7: a malformed X-Client header is refused on every auth route', async () => {
      for (const client of ['mobile/', 'tv/1.0', 'web/<script>', 'Mobile/1.0']) {
        const response = await request(t.app)
          .post('/v1/auth/refresh')
          .set('Origin', WEB_ORIGIN)
          .set('X-Client', client)
          .set('Cookie', cookieHeader(refreshToken));
        expect(response.status).toBe(403);
      }
      const login = await request(t.app)
        .post('/v1/auth/login')
        .set('X-Client', 'tv/1.0')
        .send(newCredentials());
      expect(login.status).toBe(403);
      await stillAlive();
    });

    it('S-AUTH-7: login and register from an origin that is not allow-listed are refused', async () => {
      const credentials = newCredentials();
      await register(t.app, credentials);
      for (const path of ['/v1/auth/login', '/v1/auth/register']) {
        const response = await request(t.app)
          .post(path)
          .set('Origin', 'https://evil.example')
          .send({ ...credentials, displayName: 'X' });
        expect(response.status).toBe(403);
        expect(setCookieLines(response)).toEqual([]);
      }
    });

    it('S-AUTH-7: a web client cannot pass the refresh token in the body (cookie only)', async () => {
      const response = await request(t.app)
        .post('/v1/auth/refresh')
        .set(WEB_HEADERS)
        .send({ refreshToken });
      expect(response.status).toBe(401);
      await stillAlive();
    });

    it('S-AUTH-8: a mobile client is never authenticated by a cookie (no ambient authority)', async () => {
      // What a hostile page could do if it were able to send X-Client: mobile with the cookie.
      const response = await request(t.app)
        .post('/v1/auth/refresh')
        .set('Origin', 'https://evil.example')
        .set(MOBILE_HEADERS)
        .set('Cookie', cookieHeader(refreshToken));
      expect(response.status).toBe(401);
      const logout = await request(t.app)
        .post('/v1/auth/logout')
        .set(MOBILE_HEADERS)
        .set('Cookie', cookieHeader(refreshToken));
      expect(logout.status).toBe(204);
      await stillAlive();
    });

    it('S-AUTH-7: CORS preflight from a hostile origin is not approved, so X-Client cannot be sent', async () => {
      const hostile = await request(t.app)
        .options('/v1/auth/refresh')
        .set('Origin', 'https://evil.example')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'x-client');
      expect(hostile.headers['access-control-allow-origin']).toBeUndefined();
      expect(hostile.headers['access-control-allow-credentials']).toBeUndefined();

      const friendly = await request(t.app)
        .options('/v1/auth/refresh')
        .set('Origin', WEB_ORIGIN)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'x-client');
      expect(friendly.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
      expect(friendly.headers['access-control-allow-credentials']).toBe('true');
      expect(friendly.headers['access-control-allow-headers']).toMatch(/X-Client/i);
    });

    it('S-AUTH-7: the legitimate web request passes', async () => {
      const response = await refreshWeb(t.app, refreshToken);
      expect(response.status).toBe(200);
    });
  });

  describe('brute-force protection (S-AUTH-4, NFR-SEC-005)', () => {
    it('S-AUTH-4: per-IP: the 11th auth request within a minute is 429 with Retry-After', async () => {
      const limited = await buildAuthTestApp({
        db: testDb.db.client,
        env: { API_RATE_LIMIT_AUTH_MAX: '10' },
      });
      // Different emails every time, so only the per-IP budget can be what stops them.
      for (let attempt = 1; attempt <= 10; attempt++) {
        const response = await request(limited.app)
          .post('/v1/auth/login')
          .send({ email: `spray-${attempt}@example.test`, password: 'definitely not the one' });
        expect(response.status).toBe(401);
        expect(response.headers['ratelimit-limit']).toBe('10');
      }
      const verifications = limited.hasher.verifiedAgainst.length;
      const blocked = await request(limited.app)
        .post('/v1/auth/login')
        .send({ email: 'spray-11@example.test', password: 'definitely not the one' });
      expect(blocked.status).toBe(429);
      expect(blocked.headers['content-type']).toMatch(PROBLEM_JSON);
      expect((blocked.body as { code: string }).code).toBe('RATE_LIMITED');
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      // Refused before any work: no password verification happened.
      expect(limited.hasher.verifiedAgainst.length).toBe(verifications);
      // The budget covers every auth route, not only login.
      expect((await request(limited.app).post('/v1/auth/register').send({})).status).toBe(429);
      expect(
        (await request(limited.app).post('/v1/auth/refresh').set(MOBILE_HEADERS).send({})).status,
      ).toBe(429);

      limited.clock.advance(MINUTE);
      const after = await request(limited.app)
        .post('/v1/auth/login')
        .send({ email: 'spray-12@example.test', password: 'definitely not the one' });
      expect(after.status).toBe(401);
    });

    it('S-AUTH-4: the default per-IP auth budget is 10 per minute (doc 07 §1)', async () => {
      const defaults = await buildAuthTestApp({ db: testDb.db.client });
      expect(defaults.config.rateLimit.authMax).toBe(100_000); // raised by the harness…
      const { loadEnv } = await import('../../config/env.js');
      expect(loadEnv({}).rateLimit).toMatchObject({ authMax: 10, windowMs: 60_000 }); // …not by default
    });

    it('S-AUTH-4: per-account: after 5 failures the account backs off exponentially, even for the right password', async () => {
      const credentials = newCredentials();
      await register(t.app, credentials);
      const attempt = (password: string) =>
        request(t.app).post('/v1/auth/login').send({ email: credentials.email, password });

      for (let failure = 1; failure <= 5; failure++) {
        expect((await attempt('definitely not the one')).status).toBe(401);
      }
      const verifications = t.hasher.verifiedAgainst.length;

      const waits: number[] = [];
      for (let round = 0; round < 4; round++) {
        // Locked: refused with 429 before the password is looked at, right or wrong.
        const refused = await attempt(
          round % 2 === 0 ? credentials.password : 'definitely not the one',
        );
        expect(refused.status).toBe(429);
        expect((refused.body as { code: string }).code).toBe('RATE_LIMITED');
        const retryAfter = Number(refused.headers['retry-after']);
        waits.push(retryAfter);
        expect(t.hasher.verifiedAgainst.length).toBe(verifications + round);
        t.clock.advance(retryAfter * SECOND);
        expect((await attempt('definitely not the one')).status).toBe(401);
      }
      expect(waits).toEqual([1, 2, 4, 8]);
    });

    it('S-AUTH-4: no permanent lockout: the wait is capped at 15 minutes and the right password then works', async () => {
      const credentials = newCredentials();
      await register(t.app, credentials);
      const attempt = (password: string) =>
        request(t.app).post('/v1/auth/login').send({ email: credentials.email, password });

      let longest = 0;
      for (let failure = 1; failure <= 30; failure++) {
        const response = await attempt('definitely not the one');
        if (response.status === 429) {
          const retryAfter = Number(response.headers['retry-after']);
          longest = Math.max(longest, retryAfter);
          t.clock.advance(retryAfter * SECOND);
          expect((await attempt('definitely not the one')).status).toBe(401);
        }
      }
      expect(longest).toBe(15 * 60);

      const locked = await attempt(credentials.password);
      expect(locked.status).toBe(429);
      expect(Number(locked.headers['retry-after'])).toBeLessThanOrEqual(15 * 60);
      t.clock.advance(15 * MINUTE);
      const recovered = await attempt(credentials.password);
      expect(recovered.status).toBe(200);
      // Success clears the history: five more free attempts.
      for (let failure = 1; failure <= 5; failure++) {
        expect((await attempt('definitely not the one')).status).toBe(401);
      }
    });

    it('S-AUTH-3 / S-AUTH-4: backoff is identical for an unknown email, and is per account, case-insensitively', async () => {
      const credentials = newCredentials();
      await register(t.app, credentials);
      const attempt = (email: string) =>
        request(t.app).post('/v1/auth/login').send({ email, password: 'definitely not the one' });

      const statuses = async (email: string) => {
        const seen: number[] = [];
        for (let i = 0; i < 7; i++)
          seen.push((await attempt(i % 2 ? email.toUpperCase() : email)).status);
        return seen;
      };
      const known = await statuses(credentials.email);
      const unknown = await statuses('nobody@example.test');
      expect(known).toEqual([401, 401, 401, 401, 401, 429, 429]);
      expect(unknown).toEqual(known);
      // A different account is unaffected by either lock.
      const other = newCredentials();
      await register(t.app, other);
      await loginWeb(t.app, other);
    });
  });

  describe('secrets stay out of the logs (doc 09 §7)', () => {
    it('S-AUTH: a full session at debug level logs no password, token, hash or email', async () => {
      const credentials = newCredentials('private-person');
      await register(t.app, credentials);
      const web = await loginWeb(t.app, credentials);
      const rotated = await refreshWeb(t.app, web.refreshToken);
      const newRefresh = refreshCookieValue(rotated) ?? '';
      const newAccess = (rotated.body as { accessToken: string }).accessToken;
      await getMe(t.app, newAccess);
      await refreshWeb(t.app, web.refreshToken); // reuse → warning
      await request(t.app)
        .post('/v1/auth/login')
        .send({ email: credentials.email, password: 'a wrong password attempt' });
      const mobile = await loginMobile(t.app, credentials);
      await request(t.app)
        .post('/v1/auth/logout')
        .set(MOBILE_HEADERS)
        .send({ refreshToken: mobile.refreshToken });
      await request(t.app)
        .post('/v1/auth/register')
        .send({ email: 'x', password: 'bad-register-secret', displayName: '' });

      const text = t.logs.text;
      expect(t.logs.lines.length).toBeGreaterThan(10);
      const hashes = await testDb.sql.query<{ h: string }>(
        `SELECT password_hash AS h FROM "user" UNION ALL SELECT token_hash FROM refresh_token`,
      );
      const secrets = [
        credentials.password,
        'a wrong password attempt',
        'bad-register-secret',
        web.refreshToken,
        newRefresh,
        mobile.refreshToken,
        web.accessToken,
        newAccess,
        mobile.accessToken,
        credentials.email,
        'private-person',
        t.signingJwk.d ?? 'missing',
        ...hashes.rows.map((row) => row.h),
      ];
      expect(newRefresh).toMatch(REFRESH_TOKEN);
      for (const secret of secrets) {
        expect(secret.length).toBeGreaterThan(8);
        expect(text).not.toContain(secret);
      }
      expect(text).not.toMatch(/argon2id/);
      // The security events themselves are logged, by ID only.
      const events = t.logs.lines
        .map((line) => line['event'])
        .filter((event) => event !== undefined);
      expect(events).toEqual(
        expect.arrayContaining(['register', 'login', 'refresh_reuse', 'login_failed']),
      );
    });
  });
});
