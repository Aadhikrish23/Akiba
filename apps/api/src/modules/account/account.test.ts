/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- supertest response bodies are untyped JSON; this suite reads them field by field */
import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { purgeDeletedAccounts } from '../../jobs/cleanup.js';
import { loginMobile, newCredentials, register } from '../../testing/auth.js';
import { buildCatalogTestApp, type CatalogTestApp } from '../../testing/catalog.js';
import { createTestDatabase, type TestDatabase } from '../../testing/database.js';
import { csvCell } from './account.service.js';

/**
 * T17: profile and settings, export, share link and the public shared view, account deletion and
 * restore, and the purge. FR-ACCT-001/002, FR-EXPT-001/002, FR-SHARE-001…003, Q-04, Q-09, Q-10.
 */
describe('account API (T17)', () => {
  let testDb: TestDatabase;
  let t: CatalogTestApp;
  let auth: string;
  let userId: string;
  let credentials: { email: string; password: string };

  beforeAll(async () => {
    testDb = await createTestDatabase();
  });
  afterAll(async () => {
    await testDb.drop();
  });
  beforeEach(async () => {
    await testDb.reset();
    t = await buildCatalogTestApp({ db: testDb.db.client });
    credentials = newCredentials('account');
    await register(t.app, credentials);
    const session = await loginMobile(t.app, credentials);
    auth = `Bearer ${session.accessToken}`;
    userId = session.userId;
  });

  const sql = () => testDb.sql;
  const scalar = async (text: string, values: unknown[] = []): Promise<number> =>
    Number(Object.values((await sql().query(text, values)).rows[0] as object)[0]);
  const verify = (id = userId) =>
    sql().query(`UPDATE "user" SET email_verified_at = now() WHERE id = $1`, [id]);
  const call = (
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
    path: string,
    body?: object,
    as = auth,
  ) => {
    const req = request(t.app)[method](`/v1${path}`).set('Authorization', as);
    return body === undefined ? req : req.send(body);
  };
  const newTitle = async (
    romaji: string,
    options: { adult?: boolean; episodes?: number | null } = {},
  ): Promise<string> =>
    (
      await sql().query<{ id: string }>(
        `INSERT INTO title (kind, status, title_romaji, episodes_total, is_adult, fetched_at, detail_fetched_at)
         VALUES ('tv', 'finished', $1, $2, $3, now(), now()) RETURNING id`,
        [romaji, options.episodes === undefined ? 12 : options.episodes, options.adult ?? false],
      )
    ).rows[0]!.id;
  const addEntry = async (romaji: string, status = 'watching', as = auth) => {
    const response = await call(
      'post',
      '/library',
      { titleId: await newTitle(romaji), status },
      as,
    );
    expect(response.status).toBe(201);
    return response.body.data as { id: string; title: { id: string } };
  };
  const otherUser = async (label = 'other') => {
    const other = newCredentials(label);
    await register(t.app, other);
    const session = await loginMobile(t.app, other);
    return { credentials: other, auth: `Bearer ${session.accessToken}`, userId: session.userId };
  };

  describe('settings (FR-ACCT-001, FR-LIB-004)', () => {
    it('GET /me returns the profile with the documented defaults', async () => {
      const response = await call('get', '/me');
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        id: userId,
        email: credentials.email,
        titleLanguage: 'romaji',
        timeZone: 'UTC',
        libraryView: 'grid',
        alertsEnabled: true,
        showAdult: false,
      });
    });

    it('PATCH /me changes each setting, and they persist', async () => {
      const response = await call('patch', '/me', {
        displayName: '  Hana  ',
        titleLanguage: 'english',
        timeZone: 'Asia/Kolkata',
        libraryView: 'list',
        alertsEnabled: false,
        showAdult: true,
      });
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.body).toMatchObject({
        displayName: 'Hana',
        titleLanguage: 'english',
        timeZone: 'Asia/Kolkata',
        libraryView: 'list',
        alertsEnabled: false,
        showAdult: true,
      });
      expect((await call('get', '/me')).body).toMatchObject({
        libraryView: 'list',
        timeZone: 'Asia/Kolkata',
      });
    });

    it.each([
      ['an unknown language', { titleLanguage: 'klingon' }],
      ['an unknown view', { libraryView: 'carousel' }],
      ['a time zone that does not exist', { timeZone: 'Mars/Olympus_Mons' }],
      ['an empty name', { displayName: '   ' }],
      ['a name that is too long', { displayName: 'x'.repeat(51) }],
      ['no change at all', {}],
      ['a field that is not a setting', { email: 'new@example.test' }],
      ['an ID', { id: '00000000-0000-4000-8000-000000000000' }],
      ['a flag that is not a boolean', { showAdult: 'yes' }],
    ])('refuses %s with 422', async (_label, body) => {
      expect((await call('patch', '/me', body)).status).toBe(422);
    });

    it('can only ever change the caller (there is no way to name another user)', async () => {
      const other = await otherUser();
      await call('patch', '/me', { displayName: 'Mine', libraryView: 'list' });
      expect((await call('get', '/me', undefined, other.auth)).body).toMatchObject({
        libraryView: 'grid',
      });
    });

    it('Q-10: adult-rated titles stay hidden until the user turns them on', async () => {
      const adult = await newTitle('Adult Show', { adult: true });
      expect((await call('get', `/titles/${adult}`)).status).toBe(404);
      expect((await call('post', '/library', { titleId: adult, status: 'planned' })).status).toBe(
        404,
      );

      await call('patch', '/me', { showAdult: true });
      expect((await call('get', `/titles/${adult}`)).status).toBe(200);
      expect((await call('post', '/library', { titleId: adult, status: 'planned' })).status).toBe(
        201,
      );

      // Turning it off again hides it from discovery; the user's own library keeps it.
      await call('patch', '/me', { showAdult: false });
      expect((await call('get', `/titles/${adult}`)).status).toBe(404);
      expect((await call('get', '/library')).body.data).toHaveLength(1);
    });

    it("does not let one user's adult setting show adult titles to another", async () => {
      const adult = await newTitle('Adult Show', { adult: true });
      const other = await otherUser();
      await call('patch', '/me', { showAdult: true });
      expect((await call('get', `/titles/${adult}`)).status).toBe(200);
      expect((await call('get', `/titles/${adult}`, undefined, other.auth)).status).toBe(404);
    });
  });

  describe('export (FR-EXPT-001, FR-EXPT-002)', () => {
    async function activity() {
      const a = await addEntry('Frieren');
      const b = await addEntry('Gintama', 'planned');
      await sql().query(
        `INSERT INTO title_external_id (title_id, source, external_id) VALUES ($1, 'anilist', '154587'), ($1, 'mal', '52991')`,
        [a.title.id],
      );
      await call('post', `/library/${a.id}/progress`, { set: 5 });
      await call('patch', `/library/${a.id}`, {
        rating: 9,
        review: 'Quiet and lovely',
        isFavorite: true,
        notes: 'with Sam',
      });
      await call('delete', `/library/${b.id}`);
      return { a, b };
    }

    it('returns everything the user did as a JSON file, titles with their external IDs', async () => {
      const { a, b } = await activity();
      const response = await call('post', '/me/export');
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      expect(response.headers['content-disposition']).toMatch(
        /^attachment; filename="akiba-export-\d{4}-\d{2}-\d{2}\.json"$/,
      );
      expect(response.headers['cache-control']).toBe('private, no-store');
      const file = JSON.parse(response.text);

      expect(file).toMatchObject({
        exportVersion: 1,
        user: { email: credentials.email },
        settings: { titleLanguage: 'romaji', showAdult: false },
      });
      expect(file.entries).toHaveLength(2); // including the removed one: the history is the user's
      const frieren = file.entries.find((entry: { id: string }) => entry.id === a.id);
      expect(frieren).toMatchObject({
        status: 'watching',
        progress: 5,
        rating: 9,
        review: 'Quiet and lovely',
        notes: 'with Sam',
        isFavorite: true,
        removedAt: null,
        title: { romaji: 'Frieren', akibaId: a.title.id },
      });
      expect(frieren.title.externalIds).toEqual([
        { source: 'anilist', externalId: '154587' },
        { source: 'mal', externalId: '52991' },
      ]);
      expect(frieren.runs).toHaveLength(1);
      expect(file.entries.find((entry: { id: string }) => entry.id === b.id).removedAt).toEqual(
        expect.any(String),
      );
      expect(file.favorites).toEqual([a.id]);

      // A snapshot of the database: every event is there, in order, with its run number.
      expect(file.events).toHaveLength(
        await scalar('SELECT count(*) FROM event WHERE user_id = $1', [userId]),
      );
      expect(file.events.map((event: { type: string }) => event.type)).toEqual(
        (
          await sql().query<{ type: string }>(
            `SELECT type FROM event WHERE user_id = $1 ORDER BY occurred_at, seq`,
            [userId],
          )
        ).rows.map((row) => row.type),
      );
      const progressEvent = file.events.find(
        (event: { type: string }) => event.type === 'progress_changed',
      );
      expect(progressEvent).toMatchObject({ payload: { from: 0, to: 5, run: 1 }, runNumber: 1 });
    });

    it('contains nothing of anyone else, and no credentials or tokens', async () => {
      await activity();
      const other = await otherUser('stranger');
      await addEntry('Not Mine', 'watching', other.auth);
      const text = (await call('post', '/me/export')).text;
      expect(text).not.toContain('Not Mine');
      expect(text).not.toContain(other.credentials.email);
      expect(text).not.toMatch(/argon2|password|token_hash|refresh/i);
      expect(JSON.parse(text).user.email).toBe(credentials.email);
    });

    it('?format=csv is a spreadsheet of the library: one row per active entry', async () => {
      await activity();
      const response = await call('post', '/me/export?format=csv');
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(response.headers['content-disposition']).toMatch(
        /akiba-library-\d{4}-\d{2}-\d{2}\.csv/,
      );
      const [header, ...rows] = response.text.trimEnd().split('\r\n');
      expect(header).toBe(
        'title_romaji,title_english,title_native,format,season_year,anilist_id,mal_id,status,progress,episodes_total,rating,favorite,started_at,completed_at,added_at,updated_at,notes,review',
      );
      expect(rows).toHaveLength(1); // the removed entry is not part of the library
      expect(rows[0]).toMatch(/^Frieren,,,tv,,154587,52991,watching,5,12,9,true,/);
      expect(rows[0]).toMatch(/with Sam,Quiet and lovely$/);
    });

    it('cannot be turned into a formula when opened in a spreadsheet', async () => {
      const id = await addEntry('=HYPERLINK("http://evil.example","click")');
      await call('patch', `/library/${id.id}`, {
        notes: '+cmd|calc, "quoted"\nsecond line',
        review: '@SUM(1)',
      });
      const line = (await call('post', '/me/export?format=csv')).text.split('\r\n')[1]!;
      expect(line.startsWith(`"'=HYPERLINK(""http://evil.example"",""click"")"`)).toBe(true);
      expect(line).toContain(`"'+cmd|calc, ""quoted""\nsecond line"`);
      expect(line.endsWith(`'@SUM(1)`)).toBe(true);
    });

    it('csvCell quotes delimiters and neutralises leading = + - @ tab and CR', () => {
      expect(csvCell(null)).toBe('');
      expect(csvCell(12)).toBe('12');
      expect(csvCell(false)).toBe('false');
      expect(csvCell('plain')).toBe('plain');
      expect(csvCell('a,b')).toBe('"a,b"');
      expect(csvCell('say "hi"')).toBe('"say ""hi"""');
      expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
      for (const lead of ['=', '+', '-', '@', '\t', '\r'])
        expect(csvCell(`${lead}x`).replace(/^"/, '')).toMatch(/^'/);
      expect(csvCell(-3)).toBe('-3'); // a number is not text: nothing to neutralise
    });

    it("is the caller's own, and needs a sign-in; an unknown format is 422", async () => {
      expect(
        (await request(t.app).post('/v1/me/export').set('Authorization', 'Bearer nope')).status,
      ).toBe(401);
      expect((await call('post', '/me/export?format=xml')).status).toBe(422);
      const other = await otherUser();
      expect(
        JSON.parse((await call('post', '/me/export', undefined, other.auth)).text).entries,
      ).toEqual([]);
    });
  });

  describe('share link (FR-SHARE-001…003, Q-04)', () => {
    const scope = (extra: object = {}) => ({
      scope: {
        statuses: ['watching', 'completed'],
        showRatings: false,
        showReviews: false,
        ...extra,
      },
    });
    const hash = (token: string) => createHash('sha256').update(token).digest('hex');
    const shared = (token: string, query = '') => request(t.app).get(`/v1/shared/${token}${query}`);

    it('needs a verified address to create (Q-04), but not to look', async () => {
      expect((await call('get', '/me/share')).body).toEqual({
        active: false,
        scope: null,
        createdAt: null,
      });
      const refused = await call('put', '/me/share', scope());
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('EMAIL_NOT_VERIFIED');
      expect(await scalar('SELECT count(*) FROM share_link')).toBe(0);
    });

    it('creates an unguessable link; the token is shown once and only its hash is stored', async () => {
      await verify();
      const response = await call('put', '/me/share', scope({ showRatings: true }));
      expect(response.status).toBe(200);
      const { token, url, scope: returned } = response.body;
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(url).toBe(`http://localhost:5173/shared/${token}`);
      expect(returned).toEqual({
        statuses: ['watching', 'completed'],
        showRatings: true,
        showReviews: false,
      });

      const row = (
        await sql().query(`SELECT token_hash, scope FROM share_link WHERE user_id = $1`, [userId])
      ).rows[0];
      expect(row.token_hash).toBe(hash(token));
      expect(JSON.stringify(row)).not.toContain(token);
      expect(row.scope).toEqual({
        statuses: ['watching', 'completed'],
        show_ratings: true,
        show_reviews: false,
      });

      const status = await call('get', '/me/share');
      expect(status.body).toMatchObject({ active: true, scope: returned });
      expect(JSON.stringify(status.body)).not.toContain(token);
    });

    it('the public view needs no account and shows exactly the chosen scope', async () => {
      await verify();
      const a = await addEntry('Watching Show');
      const b = await addEntry('Planned Show', 'planned');
      const c = await addEntry('Completed Show', 'completed');
      await call('patch', `/library/${a.id}`, {
        rating: 8,
        review: 'my private thoughts',
        isFavorite: true,
      });
      await call('patch', `/library/${c.id}`, { rating: 10 });
      const { token } = (await call('put', '/me/share', scope())).body;

      const response = await shared(token);
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['x-robots-tag']).toBe('noindex, nofollow');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      const names = response.body.data
        .map((entry: { title: { titleRomaji: string } }) => entry.title.titleRomaji)
        .sort();
      expect(names).toEqual(['Completed Show', 'Watching Show']); // not the Planned one
      expect(b).toBeTruthy();
      // Ratings and reviews are WITHHELD (not merely null) unless the owner chose to show them.
      for (const entry of response.body.data) {
        expect(entry).not.toHaveProperty('rating');
        expect(entry).not.toHaveProperty('review');
      }
      expect(JSON.stringify(response.body)).not.toContain('private thoughts');
      expect(response.body.owner).toEqual({ displayName: 'Test User' });
    });

    it('shows ratings and reviews only when the scope says so', async () => {
      await verify();
      const a = await addEntry('Show');
      await call('patch', `/library/${a.id}`, { rating: 8, review: 'worth it' });
      const { token } = (
        await call('put', '/me/share', scope({ showRatings: true, showReviews: true }))
      ).body;
      const entry = (await shared(token)).body.data[0];
      expect(entry).toMatchObject({
        rating: 8,
        review: 'worth it',
        isFavorite: false,
        progress: 0,
      });
    });

    it('FR-SHARE-003: exposes no email, account ID, events or anything outside the scope', async () => {
      await verify();
      await addEntry('Show');
      const { token } = (await call('put', '/me/share', scope())).body;
      const body = (await shared(token)).body;
      const text = JSON.stringify(body);
      expect(text).not.toContain(credentials.email);
      expect(text).not.toContain(userId);
      expect(text).not.toMatch(
        /"(email|userId|user_id|events?|entryId|alertsEnabled|notes|token)"/,
      );
      // Another viewer's library status never leaks through the title card either.
      for (const entry of body.data) expect(entry.title.libraryStatus).toBeNull();
    });

    it('leaves out adult titles and removed entries', async () => {
      await verify();
      await call('patch', '/me', { showAdult: true });
      const adult = await newTitle('Adult Show', { adult: true });
      await call('post', '/library', { titleId: adult, status: 'watching' });
      const gone = await addEntry('Removed Show');
      await call('delete', `/library/${gone.id}`);
      await addEntry('Visible Show');
      const { token } = (await call('put', '/me/share', scope())).body;
      expect(
        (await shared(token)).body.data.map(
          (entry: { title: { titleRomaji: string } }) => entry.title.titleRomaji,
        ),
      ).toEqual(['Visible Show']);
    });

    it('regenerating replaces the link: the old one stops working at once', async () => {
      await verify();
      const first = (await call('put', '/me/share', scope())).body.token;
      const second = (await call('put', '/me/share', scope({ showReviews: true }))).body.token;
      expect(second).not.toBe(first);
      expect((await shared(first)).status).toBe(404);
      expect((await shared(second)).status).toBe(200);
      expect(await scalar('SELECT count(*) FROM share_link')).toBe(1); // one active link per user
    });

    it('revoking is immediate, idempotent, and leaves nothing to read', async () => {
      await verify();
      const { token } = (await call('put', '/me/share', scope())).body;
      expect((await call('delete', '/me/share')).status).toBe(204);
      expect((await call('delete', '/me/share')).status).toBe(204);
      expect((await shared(token)).status).toBe(404);
      expect((await call('get', '/me/share')).body.active).toBe(false);
      // A new link can be made again.
      expect((await call('put', '/me/share', scope())).status).toBe(200);
    });

    it('answers every kind of bad token the same way', async () => {
      await verify();
      const { token } = (await call('put', '/me/share', scope())).body;
      await call('delete', '/me/share');
      const attempts = ['A'.repeat(43), 'short', token, `${token}x`, '../etc/passwd', '%00'];
      const bodies = [];
      for (const attempt of attempts) {
        const response = await shared(attempt);
        expect(response.status, attempt).toBe(404);
        bodies.push({ ...response.body, requestId: undefined });
      }
      expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1);
    });

    it('pages with a cursor and refuses odd parameters', async () => {
      await verify();
      for (let i = 1; i <= 5; i += 1) await addEntry(`Show ${i}`);
      const { token } = (await call('put', '/me/share', scope())).body;
      const first = (await shared(token, '?limit=2')).body;
      expect(first.data).toHaveLength(2);
      const second = (await shared(token, `?limit=2&cursor=${first.nextCursor}`)).body;
      expect(second.data).toHaveLength(2);
      expect(first.data[0].title.titleRomaji).not.toBe(second.data[0].title.titleRomaji);
      expect((await shared(token, '?limit=0')).status).toBe(422);
      expect((await shared(token, '?bogus=1')).status).toBe(422);
    });

    it('is rate limited per address', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 62; i += 1) statuses.push((await shared('A'.repeat(43))).status);
      expect(statuses.slice(0, 60).every((status) => status === 404)).toBe(true);
      expect(statuses.at(-1)).toBe(429);
    });

    it.each([
      ['no statuses', { statuses: [], showRatings: false, showReviews: false }],
      ['an unknown status', { statuses: ['finished'], showRatings: false, showReviews: false }],
      [
        'an extra field',
        { statuses: ['watching'], showRatings: false, showReviews: false, showEmail: true },
      ],
      ['missing flags', { statuses: ['watching'] }],
    ])('refuses a scope with %s', async (_label, bad) => {
      await verify();
      expect((await call('put', '/me/share', { scope: bad })).status).toBe(422);
    });

    it("is the caller's own: another user's link cannot be read, replaced or revoked through these routes", async () => {
      await verify();
      const { token } = (await call('put', '/me/share', scope())).body;
      const other = await otherUser();
      await verify(other.userId);
      expect((await call('get', '/me/share', undefined, other.auth)).body.active).toBe(false);
      await call('delete', '/me/share', undefined, other.auth);
      expect((await shared(token)).status).toBe(200);
    });

    it('the owner being deleted ends the link', async () => {
      await verify();
      const { token } = (await call('put', '/me/share', scope())).body;
      await call('delete', '/me', { password: credentials.password });
      expect((await shared(token)).status).toBe(404);
    });
  });

  describe('deleting the account and restoring it (FR-ACCT-002, Q-09)', () => {
    it('asks for the password: a wrong one changes nothing', async () => {
      const response = await call('delete', '/me', { password: 'not my password' });
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('REAUTHENTICATION_FAILED');
      expect(
        await scalar('SELECT count(*) FROM "user" WHERE id = $1 AND deleted_at IS NULL', [userId]),
      ).toBe(1);
      expect((await call('get', '/me')).status).toBe(200);
      expect((await call('delete', '/me', {})).status).toBe(422);
      expect(
        (await call('delete', '/me', { password: credentials.password, extra: 1 })).status,
      ).toBe(422);
    });

    it('schedules erasure after 14 days, ends every session, and takes the account out of use', async () => {
      await addEntry('Show');
      const second = await loginMobile(t.app, credentials); // another device
      const response = await call('delete', '/me', { password: credentials.password });
      expect(response.status).toBe(202);
      expect(response.body.status).toBe('deletion_scheduled');
      const row = (
        await sql().query(`SELECT deleted_at, purge_after FROM "user" WHERE id = $1`, [userId])
      ).rows[0];
      expect(row.deleted_at).not.toBeNull();
      expect(new Date(row.purge_after).getTime() - new Date(row.deleted_at).getTime()).toBe(
        14 * 24 * 60 * 60 * 1000,
      );
      expect(response.body.purgeAfter).toBe(new Date(row.purge_after).toISOString());

      // Both devices are signed out, and the account can no longer sign in.
      expect((await call('get', '/me')).status).toBe(401);
      expect((await call('get', '/me', undefined, `Bearer ${second.accessToken}`)).status).toBe(
        401,
      );
      expect((await request(t.app).post('/v1/auth/login').send(credentials)).status).toBe(401);
      // Nothing is erased yet.
      expect(await scalar('SELECT count(*) FROM library_entry WHERE user_id = $1', [userId])).toBe(
        1,
      );
    });

    it('restoring within the grace period brings the account and its data back', async () => {
      await addEntry('Show');
      await verify();
      const { token } = (
        await call('put', '/me/share', {
          scope: { statuses: ['watching'], showRatings: false, showReviews: false },
        })
      ).body;
      await call('delete', '/me', { password: credentials.password });

      const restored = await request(t.app).post('/v1/auth/restore').send(credentials);
      expect(restored.status).toBe(200);
      expect(restored.body).toEqual({ status: 'restored' });

      const session = await loginMobile(t.app, credentials);
      const again = `Bearer ${session.accessToken}`;
      expect((await call('get', '/library', undefined, again)).body.data).toHaveLength(1);
      // A link that was live before the deletion stays revoked: restoring must not republish.
      expect((await request(t.app).get(`/v1/shared/${token}`)).status).toBe(404);
      expect((await call('get', '/me/share', undefined, again)).body.active).toBe(false);
    });

    it('restore answers every failure the same way: wrong password, not deleted, unknown, grace over', async () => {
      await call('delete', '/me', { password: credentials.password });
      const live = await otherUser('live');
      const failures = [
        await request(t.app)
          .post('/v1/auth/restore')
          .send({ email: credentials.email, password: 'wrong password here' }),
        await request(t.app).post('/v1/auth/restore').send(live.credentials),
        await request(t.app)
          .post('/v1/auth/restore')
          .send({ email: 'nobody@example.test', password: 'whatever password' }),
      ];
      // The auth module runs on the test clock, so "over" is measured on that clock.
      await sql().query('UPDATE "user" SET purge_after = $2 WHERE id = $1', [
        userId,
        new Date(t.clock.now().getTime() - 60_000),
      ]);
      failures.push(await request(t.app).post('/v1/auth/restore').send(credentials));
      for (const failure of failures) {
        expect(failure.status).toBe(401);
        expect(failure.body.code).toBe('INVALID_CREDENTIALS');
      }
      expect(new Set(failures.map((failure) => String(failure.body.detail))).size).toBe(1);
      expect(
        await scalar('SELECT count(*) FROM "user" WHERE id = $1 AND deleted_at IS NOT NULL', [
          userId,
        ]),
      ).toBe(1);
    });

    it('guessing at restore is throttled like guessing at login', async () => {
      await call('delete', '/me', { password: credentials.password });
      let status = 0;
      for (let i = 0; i < 12; i += 1) {
        status = (
          await request(t.app)
            .post('/v1/auth/restore')
            .send({ email: credentials.email, password: `guess number ${i}` })
        ).status;
      }
      expect(status).toBe(429);
    });

    it('clears the refresh cookie of a web client on deletion', async () => {
      const response = await request(t.app)
        .post('/v1/auth/login')
        .set({ Origin: 'https://app.akiba.test', 'X-Client': 'web/1.0.0' })
        .send(credentials);
      const access = response.body.accessToken as string;
      const deletion = await request(t.app)
        .delete('/v1/me')
        .set('Authorization', `Bearer ${access}`)
        .send({ password: credentials.password });
      expect(deletion.status).toBe(202);
      expect(String(deletion.headers['set-cookie'])).toMatch(/akiba_refresh=;/);
    });

    it('purge erases accounts whose grace is over, with everything they own, and nobody else', async () => {
      await verify();
      const mine = await addEntry('Mine');
      await call('post', `/library/${mine.id}/progress`, { delta: 1 });
      await call('put', '/me/share', {
        scope: { statuses: ['watching'], showRatings: false, showReviews: false },
      });
      const bystander = await otherUser('bystander');
      await addEntry('Theirs', 'watching', bystander.auth);
      const pending = await otherUser('pending');
      await call('delete', '/me', { password: pending.credentials.password }, pending.auth);
      await call('delete', '/me', { password: credentials.password });

      // Nothing is due yet.
      expect(await purgeDeletedAccounts(testDb.db.client)).toBe(0);
      await sql().query(`UPDATE "user" SET purge_after = now() - interval '1 day' WHERE id = $1`, [
        userId,
      ]);
      expect(await purgeDeletedAccounts(testDb.db.client)).toBe(1);

      expect(await scalar('SELECT count(*) FROM "user" WHERE id = $1', [userId])).toBe(0);
      for (const table of ['library_entry', 'event', 'share_link', 'refresh_token']) {
        expect(
          await scalar(`SELECT count(*) FROM ${table} WHERE user_id = $1`, [userId]),
          table,
        ).toBe(0);
      }
      expect(await scalar('SELECT count(*) FROM viewing_run WHERE entry_id = $1', [mine.id])).toBe(
        0,
      );
      // Others are untouched: the bystander's library, and the pending account's own grace period.
      expect(
        await scalar('SELECT count(*) FROM library_entry WHERE user_id = $1', [bystander.userId]),
      ).toBe(1);
      expect(
        await scalar('SELECT count(*) FROM event WHERE user_id = $1', [bystander.userId]),
      ).toBeGreaterThan(0);
      expect(
        await scalar('SELECT count(*) FROM "user" WHERE id = $1 AND deleted_at IS NOT NULL', [
          pending.userId,
        ]),
      ).toBe(1);
      // Idempotent.
      expect(await purgeDeletedAccounts(testDb.db.client)).toBe(0);
      // The catalog (titles) is shared and stays.
      expect(await scalar('SELECT count(*) FROM title')).toBeGreaterThanOrEqual(2);
    });
  });
});
