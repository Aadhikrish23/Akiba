/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- supertest response bodies are untyped JSON; this suite reads them field by field */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildCatalogTestApp, type CatalogTestApp } from '../../testing/catalog.js';
import { createTestDatabase, type TestDatabase } from '../../testing/database.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * T15: the library (doc 07 §4) on a real database: add, status, favourites, soft removal, filters
 * and sorts. FR-LIB-001…007; doc 06 §4 invariants 1, 6 and 7; doc 11 §3.2 (IDOR).
 */
describe('library API (T15, FR-LIB-001…007)', () => {
  let testDb: TestDatabase;
  let t: CatalogTestApp;
  let auth: string;
  let userId: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
  });
  afterAll(async () => {
    await testDb.drop();
  });
  beforeEach(async () => {
    await testDb.reset();
    t = await buildCatalogTestApp({ db: testDb.db.client });
    ({ auth, userId } = await t.signIn());
  });

  const sql = () => testDb.sql;
  const scalar = async (text: string, values: unknown[] = []): Promise<number> =>
    Number(Object.values((await sql().query(text, values)).rows[0] as object)[0]);
  const eventTypes = async (entryId: string): Promise<string[]> =>
    (
      await sql().query<{ type: string }>(
        `SELECT type FROM event WHERE entry_id = $1 ORDER BY occurred_at, seq`,
        [entryId],
      )
    ).rows.map((row) => row.type);

  interface TitleSeed {
    romaji: string;
    english?: string;
    kind?: string;
    year?: number;
    episodes?: number | null;
    genres?: string[];
    adult?: boolean;
  }
  const newTitle = async (seed: TitleSeed): Promise<string> => {
    const row = (
      await sql().query<{ id: string }>(
        `INSERT INTO title (kind, status, title_romaji, title_english, season_year, episodes_total, is_adult, fetched_at, detail_fetched_at)
         VALUES ($1::title_kind, 'finished', $2, $3, $4, $5, $6, now(), now()) RETURNING id`,
        [
          seed.kind ?? 'tv',
          seed.romaji,
          seed.english ?? null,
          seed.year ?? null,
          seed.episodes === undefined ? 12 : seed.episodes,
          seed.adult ?? false,
        ],
      )
    ).rows[0]!;
    for (const name of seed.genres ?? []) {
      const genre = (
        await sql().query<{ id: string }>(
          `INSERT INTO genre (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
          [name],
        )
      ).rows[0]!;
      await sql().query(`INSERT INTO title_genre (title_id, genre_id) VALUES ($1, $2)`, [
        row.id,
        genre.id,
      ]);
    }
    return row.id;
  };

  const add = (titleId: string, status = 'watching', as = auth) =>
    request(t.app).post('/v1/library').set('Authorization', as).send({ titleId, status });
  const patch = (entryId: string, body: object, as = auth) =>
    request(t.app).patch(`/v1/library/${entryId}`).set('Authorization', as).send(body);
  const del = (entryId: string, as = auth) =>
    request(t.app).delete(`/v1/library/${entryId}`).set('Authorization', as);
  const list = (query = '', as = auth) => t.get(`/library${query}`, as);
  const names = (body: { data: Array<{ title: { titleRomaji: string } }> }): string[] =>
    body.data.map((entry) => entry.title.titleRomaji);

  describe('adding (FR-LIB-001)', () => {
    it.each(['watching', 'completed', 'planned', 'on_hold', 'dropped'] as const)(
      'adds a title as %s',
      async (status) => {
        const title = await newTitle({ romaji: 'Show', episodes: 12 });
        const response = await add(title, status);
        expect(response.status).toBe(201);
        expect(response.headers['cache-control']).toBe('private, no-store');
        expect(response.body.data).toMatchObject({
          status,
          effectiveTotal: 12,
          totalOverridden: false,
          isFavorite: false,
          rating: null,
          title: { id: title, titleRomaji: 'Show', libraryStatus: status },
        });
        expect(response.body.data.id).toMatch(UUID);
        // Run 1 exists from the start; the first watch is a run like any other.
        expect(response.body.data.runs).toHaveLength(1);
        expect(response.body.data.runs[0]).toMatchObject({ runNumber: 1 });
      },
    );

    it('a title added as Watching starts now and has one open run', async () => {
      const response = await add(await newTitle({ romaji: 'Show' }), 'watching');
      expect(response.body.data).toMatchObject({ progress: 0, completedAt: null });
      expect(response.body.data.startedAt).toEqual(expect.any(String));
      expect(response.body.data.runs[0].finishedAt).toBeNull();
      expect(await eventTypes(response.body.data.id)).toEqual(['entry_added', 'run_started']);
    });

    it('a Planned title has not been started', async () => {
      const response = await add(await newTitle({ romaji: 'Show' }), 'planned');
      expect(response.body.data.startedAt).toBeNull();
    });

    it('a title added as Completed has been watched in full: progress, dates, a finished run, and the events say so', async () => {
      const response = await add(await newTitle({ romaji: 'Show', episodes: 24 }), 'completed');
      const entry = response.body.data;
      expect(entry).toMatchObject({ progress: 24, status: 'completed' });
      expect(entry.completedAt).toEqual(expect.any(String));
      expect(entry.runs[0]).toMatchObject({ runNumber: 1, progressAtEnd: 24 });
      expect(entry.runs[0].finishedAt).toEqual(expect.any(String));
      expect(await eventTypes(entry.id)).toEqual([
        'entry_added',
        'run_started',
        'progress_changed',
        'run_completed',
      ]);
    });

    it('Completed with an unknown total keeps progress at 0 rather than inventing a number', async () => {
      const response = await add(await newTitle({ romaji: 'Show', episodes: null }), 'completed');
      expect(response.body.data).toMatchObject({ progress: 0, effectiveTotal: null });
    });

    it('refuses an unknown title, an adult title, and a body that is not valid', async () => {
      expect((await add('00000000-0000-4000-8000-000000000000')).status).toBe(404);
      expect((await add(await newTitle({ romaji: 'Adult', adult: true }))).status).toBe(404);
      for (const body of [
        { titleId: 'not-a-uuid', status: 'watching' },
        { titleId: await newTitle({ romaji: 'X' }), status: 'finished' },
        { titleId: await newTitle({ romaji: 'Y' }) },
        { titleId: await newTitle({ romaji: 'Z' }), status: 'watching', rating: 10 },
      ]) {
        const response = await request(t.app)
          .post('/v1/library')
          .set('Authorization', auth)
          .send(body);
        expect(response.status).toBe(422);
        expect(response.body.code).toBe('VALIDATION_ERROR');
      }
      expect(await scalar('SELECT count(*) FROM library_entry')).toBe(0);
    });
  });

  describe('no duplicates (FR-LIB-006, doc 06 §4 invariant 1)', () => {
    it('a second add is 409 and names the entry the user already has', async () => {
      const title = await newTitle({ romaji: 'Show' });
      const first = await add(title, 'watching');
      const second = await add(title, 'planned');
      expect(second.status).toBe(409);
      expect(second.body).toMatchObject({
        code: 'ALREADY_IN_LIBRARY',
        entryId: first.body.data.id,
      });
      expect(second.headers['content-type']).toMatch(/problem\+json/);
      expect(await scalar('SELECT count(*) FROM library_entry')).toBe(1);
      expect((await t.get(`/library/${first.body.data.id}`, auth)).body.data.status).toBe(
        'watching',
      ); // untouched
    });

    it('two requests at the same moment: one entry, one 201 and one 409', async () => {
      const title = await newTitle({ romaji: 'Race' });
      const responses = await Promise.all(Array.from({ length: 6 }, () => add(title)));
      expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
      expect(responses.filter((response) => response.status === 409)).toHaveLength(5);
      expect(await scalar('SELECT count(*) FROM library_entry')).toBe(1);
      expect(await scalar(`SELECT count(*) FROM event WHERE type = 'entry_added'`)).toBe(1);
    });

    it('two users can have the same title', async () => {
      const title = await newTitle({ romaji: 'Shared' });
      const other = await t.signIn('other');
      expect((await add(title, 'watching', auth)).status).toBe(201);
      expect((await add(title, 'completed', other.auth)).status).toBe(201);
    });
  });

  describe('changing status (FR-LIB-002)', () => {
    it('records the change with where it came from and where it went', async () => {
      const entry = (await add(await newTitle({ romaji: 'Show' }), 'planned')).body.data;
      const response = await patch(entry.id, { status: 'watching' });
      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('watching');
      expect(response.body.data.startedAt).toEqual(expect.any(String)); // Planned → Watching starts it
      const event = (
        await sql().query(
          `SELECT payload FROM event WHERE entry_id = $1 AND type = 'status_changed'`,
          [entry.id],
        )
      ).rows[0];
      expect(event.payload).toEqual({ from: 'planned', to: 'watching' });
    });

    it('marking Completed finishes the run, moves progress to the total and sets the date', async () => {
      const entry = (await add(await newTitle({ romaji: 'Show', episodes: 12 }), 'watching')).body
        .data;
      const response = await patch(entry.id, { status: 'completed' });
      expect(response.body.data).toMatchObject({ status: 'completed', progress: 12 });
      expect(response.body.data.completedAt).toEqual(expect.any(String));
      expect(response.body.data.runs[0]).toMatchObject({ progressAtEnd: 12 });
      expect(response.body.data.runs[0].finishedAt).not.toBeNull();
      expect(await eventTypes(entry.id)).toEqual([
        'entry_added',
        'run_started',
        'status_changed',
        'progress_changed',
        'run_completed',
      ]);
    });

    it('leaving Completed reopens the run: it was a correction, not a second watch', async () => {
      const entry = (await add(await newTitle({ romaji: 'Show', episodes: 12 }), 'completed')).body
        .data;
      const response = await patch(entry.id, { status: 'watching' });
      expect(response.body.data).toMatchObject({ status: 'watching', completedAt: null });
      expect(response.body.data.runs).toHaveLength(1);
      expect(response.body.data.runs[0]).toMatchObject({ finishedAt: null, progressAtEnd: null });
    });

    it('changing to the same status, or the same favourite, writes nothing and keeps updatedAt', async () => {
      const entry = (await add(await newTitle({ romaji: 'Show' }), 'watching')).body.data;
      const before = await eventTypes(entry.id);
      const response = await patch(entry.id, { status: 'watching', isFavorite: false });
      expect(response.status).toBe(200);
      expect(response.body.data.updatedAt).toBe(entry.updatedAt);
      expect(await eventTypes(entry.id)).toEqual(before);
    });

    it('an unknown status or field, or an empty change, is 422', async () => {
      const entry = (await add(await newTitle({ romaji: 'Show' }))).body.data;
      for (const body of [
        { status: 'finished' },
        {},
        { surprise: true },
        { progress: 5 },
        { notes: 'x'.repeat(2001) },
      ]) {
        expect((await patch(entry.id, body)).status, JSON.stringify(body).slice(0, 40)).toBe(422);
      }
    });

    it('keeps notes and per-entry alert settings, without an event (they are not history)', async () => {
      const entry = (await add(await newTitle({ romaji: 'Show' }))).body.data;
      const response = await patch(entry.id, { notes: 'rewatch with Sam', alertsEnabled: false });
      expect(response.body.data).toMatchObject({ notes: 'rewatch with Sam', alertsEnabled: false });
      expect(await eventTypes(entry.id)).toEqual(['entry_added', 'run_started']);
      expect(
        (await patch(entry.id, { notes: '   ', alertsEnabled: null })).body.data,
      ).toMatchObject({ notes: null, alertsEnabled: null });
    });
  });

  describe('favourites (FR-LIB-007)', () => {
    it('marks and unmarks, one event each, and lists them', async () => {
      const a = (await add(await newTitle({ romaji: 'Alpha' }))).body.data;
      await add(await newTitle({ romaji: 'Beta' }));
      expect((await patch(a.id, { isFavorite: true })).body.data.isFavorite).toBe(true);
      expect(names((await t.get('/library/favorites', auth)).body)).toEqual(['Alpha']);
      await patch(a.id, { isFavorite: false });
      expect((await t.get('/library/favorites', auth)).body.data).toEqual([]);
      expect(await eventTypes(a.id)).toEqual([
        'entry_added',
        'run_started',
        'favorited',
        'unfavorited',
      ]);
    });
  });

  describe('removing keeps the history (FR-LIB-002, doc 06 §3)', () => {
    it('hides the entry but keeps the row and every event, and adds one more', async () => {
      const entry = (await add(await newTitle({ romaji: 'Show' }), 'watching')).body.data;
      const response = await del(entry.id);
      expect(response.status).toBe(204);
      expect((await t.get(`/library/${entry.id}`, auth)).status).toBe(404);
      expect((await list('', auth)).body.data).toEqual([]);
      expect(
        await scalar(
          `SELECT count(*) FROM library_entry WHERE id = $1 AND removed_at IS NOT NULL`,
          [entry.id],
        ),
      ).toBe(1);
      expect(await eventTypes(entry.id)).toEqual(['entry_added', 'run_started', 'entry_removed']);
      // A second removal finds nothing to remove.
      expect((await del(entry.id)).status).toBe(404);
    });

    it('a removed title no longer shows as on the shelf', async () => {
      const title = await newTitle({ romaji: 'Show' });
      const entry = (await add(title)).body.data;
      expect((await t.get(`/titles/${title}`, auth)).body.data.libraryStatus).toBe('watching');
      await del(entry.id);
      expect((await t.get(`/titles/${title}`, auth)).body.data.libraryStatus).toBeNull();
    });

    it('adding it again brings the same entry back as a NEW run, with the old runs and events intact', async () => {
      const title = await newTitle({ romaji: 'Show', episodes: 12 });
      const first = (await add(title, 'completed')).body.data;
      await del(first.id);

      const again = await add(title, 'watching');
      expect(again.status).toBe(201);
      expect(again.body.data.id).toBe(first.id); // the tombstone is revived, not duplicated
      expect(again.body.data).toMatchObject({ status: 'watching', progress: 0, completedAt: null });
      expect(
        again.body.data.runs.map((run: { runNumber: number; finishedAt: string | null }) => [
          run.runNumber,
          run.finishedAt !== null,
        ]),
      ).toEqual([
        [1, true],
        [2, false],
      ]);
      expect(await scalar('SELECT count(*) FROM library_entry')).toBe(1);
      const types = await eventTypes(first.id);
      expect(types.filter((type) => type === 'entry_added')).toHaveLength(2);
      expect(types).toContain('entry_removed');
    });
  });

  describe('listing (FR-LIB-003, FR-LIB-005)', () => {
    async function seed() {
      const frieren = await newTitle({
        romaji: 'Sousou no Frieren',
        english: "Frieren: Beyond Journey's End",
        kind: 'tv',
        year: 2023,
        genres: ['Fantasy', 'Adventure'],
      });
      const gintama = await newTitle({
        romaji: 'Gintama',
        kind: 'tv',
        year: 2006,
        genres: ['Comedy'],
      });
      const movie = await newTitle({
        romaji: 'Kimi no Na wa',
        kind: 'movie',
        year: 2016,
        genres: ['Romance'],
        episodes: 1,
      });
      const entries = {
        frieren: (await add(frieren, 'watching')).body.data.id as string,
        gintama: (await add(gintama, 'completed')).body.data.id as string,
        movie: (await add(movie, 'planned')).body.data.id as string,
      };
      // Different update times and a rating on one entry (ratings arrive in T16; the column exists).
      await sql().query(
        `UPDATE library_entry SET updated_at = now() - interval '3 days', rating = 9 WHERE id = $1`,
        [entries.gintama],
      );
      await sql().query(
        `UPDATE library_entry SET updated_at = now() - interval '1 day', progress = 5 WHERE id = $1`,
        [entries.frieren],
      );
      await sql().query(
        `UPDATE library_entry SET started_at = now() - interval '10 days' WHERE id = $1`,
        [entries.gintama],
      );
      return entries;
    }

    it("lists the user's entries, most recently updated first by default", async () => {
      await seed();
      const body = (await list()).body;
      expect(names(body)).toEqual(['Kimi no Na wa', 'Sousou no Frieren', 'Gintama']);
      expect(body.nextCursor).toBeNull();
    });

    it.each([
      ['status', '?status=completed', ['Gintama']],
      ['format', '?format=movie', ['Kimi no Na wa']],
      ['genre (any case)', '?genre=fantasy', ['Sousou no Frieren']],
      ['year', '?year=2016', ['Kimi no Na wa']],
      ['minimum rating', '?minRating=8', ['Gintama']],
      ['name, romaji', '?q=frier', ['Sousou no Frieren']],
      ['name, English', '?q=beyond%20journey', ['Sousou no Frieren']],
      ['name, in the middle', '?q=tama', ['Gintama']],
      ['filters together', '?format=tv&status=watching', ['Sousou no Frieren']],
      ['filters that exclude everything', '?format=movie&status=watching', []],
    ])('filters by %s', async (_label, query, expected) => {
      await seed();
      expect(names((await list(query)).body)).toEqual(expected);
    });

    it.each([
      ['updated', '?sort=updated', ['Kimi no Na wa', 'Sousou no Frieren', 'Gintama']],
      [
        'updated, oldest first',
        '?sort=updated&order=asc',
        ['Gintama', 'Sousou no Frieren', 'Kimi no Na wa'],
      ],
      ['title', '?sort=title', ['Gintama', 'Kimi no Na wa', 'Sousou no Frieren']],
      [
        'title, reversed',
        '?sort=title&order=desc',
        ['Sousou no Frieren', 'Kimi no Na wa', 'Gintama'],
      ],
      ['rating (unrated last)', '?sort=rating', ['Gintama', 'Kimi no Na wa', 'Sousou no Frieren']],
      ['progress', '?sort=progress', ['Gintama', 'Sousou no Frieren', 'Kimi no Na wa']],
      ['start date', '?sort=start_date', ['Sousou no Frieren', 'Gintama', 'Kimi no Na wa']],
    ])('sorts by %s', async (_label, query, expected) => {
      await seed();
      const result = names((await list(query)).body);
      // Gintama's progress is its total (12); entries with equal values fall back to recency.
      expect(result).toEqual(expected);
    });

    it('pages with an opaque cursor (FR-DISC style), without gaps or repeats', async () => {
      for (let i = 1; i <= 5; i += 1) await add(await newTitle({ romaji: `Title ${i}` }));
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query: string = `?sort=title&limit=2${cursor === null ? '' : `&cursor=${cursor}`}`;
        const body = (await list(query)).body;
        seen.push(...names(body));
        cursor = body.nextCursor;
        pages += 1;
      } while (cursor !== null);
      expect(pages).toBe(3);
      expect(seen).toEqual(['Title 1', 'Title 2', 'Title 3', 'Title 4', 'Title 5']);
    });

    it('rejects a bad cursor, an unknown sort, a limit out of range and stray parameters with 422', async () => {
      for (const query of [
        '?cursor=garbage',
        '?sort=name',
        '?limit=0',
        '?limit=101',
        '?bogus=1',
        '?minRating=11',
        '?status=done',
      ]) {
        expect((await list(query)).status, query).toBe(422);
      }
    });
  });

  describe('entry detail', () => {
    it('returns the entry with its runs, review and notes', async () => {
      const entry = (await add(await newTitle({ romaji: 'Show' }))).body.data;
      const response = await t.get(`/library/${entry.id}`, auth);
      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({ id: entry.id, review: null, notes: null });
      expect(response.body.data.runs).toHaveLength(1);
    });

    it('is 404 for an unknown or malformed ID', async () => {
      expect((await t.get('/library/00000000-0000-4000-8000-000000000000', auth)).status).toBe(404);
      expect((await t.get('/library/not-an-id', auth)).status).toBe(404);
    });
  });

  describe('privacy (doc 11 §3.2, IDOR)', () => {
    it("another user's entry does not exist: read, change and remove are all 404 and change nothing", async () => {
      const entry = (await add(await newTitle({ romaji: 'Private' }), 'watching')).body.data;
      const other = await t.signIn('intruder');
      const eventsBefore = await scalar('SELECT count(*) FROM event');

      expect((await t.get(`/library/${entry.id}`, other.auth)).status).toBe(404);
      expect(
        (await patch(entry.id, { status: 'dropped', isFavorite: true }, other.auth)).status,
      ).toBe(404);
      expect((await del(entry.id, other.auth)).status).toBe(404);

      expect(await scalar('SELECT count(*) FROM event')).toBe(eventsBefore);
      const stored = (
        await sql().query(
          `SELECT status, is_favorite, removed_at FROM library_entry WHERE id = $1`,
          [entry.id],
        )
      ).rows[0];
      expect(stored).toEqual({ status: 'watching', is_favorite: false, removed_at: null });
    });

    it("lists, favourites and filters show only the caller's entries", async () => {
      await add(await newTitle({ romaji: 'Mine' }));
      const other = await t.signIn('other');
      await add(await newTitle({ romaji: 'Theirs' }), 'watching', other.auth);
      expect(names((await list()).body)).toEqual(['Mine']);
      expect(names((await list('', other.auth)).body)).toEqual(['Theirs']);
      expect(names((await list('?q=theirs')).body)).toEqual([]);
    });

    it('needs a signed-in user for every route', async () => {
      const id = '00000000-0000-4000-8000-000000000000';
      const calls = [
        request(t.app).get('/v1/library'),
        request(t.app).get('/v1/library/favorites'),
        request(t.app).post('/v1/library').send({ titleId: id, status: 'watching' }),
        request(t.app).get(`/v1/library/${id}`),
        request(t.app).patch(`/v1/library/${id}`).send({ status: 'dropped' }),
        request(t.app).delete(`/v1/library/${id}`),
      ];
      for (const call of calls) {
        const response = await call.set('Authorization', 'Bearer nope');
        expect(response.status).toBe(401);
      }
    });
  });

  describe('every change and its event are ONE transaction (doc 06 §4 invariant 6, doc 11 §3.4)', () => {
    /** Fault injection: the database refuses to store an event, as a failing disk or a bug would. */
    const failEvents = () =>
      sql().query(`
        CREATE OR REPLACE FUNCTION test_fail_event() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN RAISE EXCEPTION 'injected failure: event insert'; END $$;
        CREATE TRIGGER test_fail_event BEFORE INSERT ON event
          FOR EACH ROW EXECUTE FUNCTION test_fail_event();`);
    const healEvents = () =>
      sql().query(
        `DROP TRIGGER IF EXISTS test_fail_event ON event; DROP FUNCTION IF EXISTS test_fail_event()`,
      );

    it('adding: a failing event insert leaves no entry, no run and no event', async () => {
      const title = await newTitle({ romaji: 'Show' });
      await failEvents();
      try {
        const response = await add(title);
        expect(response.status).toBe(500);
      } finally {
        await healEvents();
      }
      expect(await scalar('SELECT count(*) FROM library_entry')).toBe(0);
      expect(await scalar('SELECT count(*) FROM viewing_run')).toBe(0);
      expect(await scalar('SELECT count(*) FROM event')).toBe(0);
      // And the title can be added once the fault is gone: nothing was half-done.
      expect((await add(title)).status).toBe(201);
    });

    it('changing status: a failing event insert leaves the entry and its run exactly as they were', async () => {
      const entry = (await add(await newTitle({ romaji: 'Show', episodes: 12 }), 'watching')).body
        .data;
      await failEvents();
      try {
        expect((await patch(entry.id, { status: 'completed' })).status).toBe(500);
        expect((await patch(entry.id, { isFavorite: true })).status).toBe(500);
        expect((await del(entry.id)).status).toBe(500);
      } finally {
        await healEvents();
      }
      const stored = (
        await sql().query(
          `SELECT status, progress, is_favorite, completed_at, removed_at FROM library_entry WHERE id = $1`,
          [entry.id],
        )
      ).rows[0];
      expect(stored).toEqual({
        status: 'watching',
        progress: 0,
        is_favorite: false,
        completed_at: null,
        removed_at: null,
      });
      expect(
        await scalar(
          `SELECT count(*) FROM viewing_run WHERE entry_id = $1 AND finished_at IS NULL`,
          [entry.id],
        ),
      ).toBe(1);
      expect(await eventTypes(entry.id)).toEqual(['entry_added', 'run_started']);
    });

    it('events of one change are stored in the order things happened (by seq)', async () => {
      const entry = (await add(await newTitle({ romaji: 'Show', episodes: 3 }), 'completed')).body
        .data;
      const rows = (
        await sql().query<{ type: string; occurred_at: Date }>(
          `SELECT type, occurred_at FROM event WHERE entry_id = $1 ORDER BY occurred_at, seq`,
          [entry.id],
        )
      ).rows;
      expect(rows.map((row) => row.type)).toEqual([
        'entry_added',
        'run_started',
        'progress_changed',
        'run_completed',
      ]);
      const times = rows.map((row) => row.occurred_at.getTime());
      expect(times).toEqual([...times].sort((a, b) => a - b));
    });

    it('library entries and events reference Akiba IDs only (invariant 7)', async () => {
      const title = await newTitle({ romaji: 'Show' });
      const entry = (await add(title)).body.data;
      const referenced = (
        await sql().query<{ title_id: string }>(
          `SELECT title_id FROM library_entry UNION SELECT title_id FROM event WHERE entry_id = $1`,
          [entry.id],
        )
      ).rows;
      expect(referenced).toEqual([{ title_id: title }]);
      expect(
        await scalar(
          `SELECT count(*) FROM library_entry le LEFT JOIN title t ON t.id = le.title_id WHERE t.id IS NULL`,
        ),
      ).toBe(0);
    });
  });

  it("the caller's own ID is never taken from the request", async () => {
    const title = await newTitle({ romaji: 'Show' });
    const other = await t.signIn('victim');
    // A smuggled userId is refused as an unknown field, not honoured.
    const response = await request(t.app)
      .post('/v1/library')
      .set('Authorization', auth)
      .send({ titleId: title, status: 'watching', userId: other.userId });
    expect(response.status).toBe(422);
    expect(await scalar('SELECT count(*) FROM library_entry')).toBe(0);
    void userId;
  });
});
