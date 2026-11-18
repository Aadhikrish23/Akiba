/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- supertest response bodies are untyped JSON; this suite reads them field by field */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildCatalogTestApp, type CatalogTestApp } from '../../testing/catalog.js';
import { createTestDatabase, pgFailure, type TestDatabase } from '../../testing/database.js';

/**
 * T16: progress, episode total, ratings, reviews, rewatch runs and the history timeline.
 * FR-TRK-001…008, FR-REM-001…005 and -007; doc 06 §4 invariants; doc 11 §3.4.
 */
describe('tracking and history (T16)', () => {
  let testDb: TestDatabase;
  let t: CatalogTestApp;
  let auth: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
  });
  afterAll(async () => {
    await testDb.drop();
  });
  beforeEach(async () => {
    await testDb.reset();
    t = await buildCatalogTestApp({ db: testDb.db.client });
    ({ auth } = await t.signIn());
  });

  const sql = () => testDb.sql;
  const scalar = async (text: string, values: unknown[] = []): Promise<number> =>
    Number(Object.values((await sql().query(text, values)).rows[0] as object)[0]);
  const events = async (entryId: string) =>
    (
      await sql().query<{ type: string; payload: Record<string, unknown>; run_id: string | null }>(
        `SELECT type, payload, run_id FROM event WHERE entry_id = $1 ORDER BY occurred_at, seq`,
        [entryId],
      )
    ).rows;
  const eventTypes = async (entryId: string): Promise<string[]> =>
    (await events(entryId)).map((event) => event.type);

  const newTitle = async (episodes: number | null = 12, romaji = 'Show'): Promise<string> =>
    (
      await sql().query<{ id: string }>(
        `INSERT INTO title (kind, status, title_romaji, episodes_total, fetched_at, detail_fetched_at)
         VALUES ('tv', 'finished', $1, $2, now(), now()) RETURNING id`,
        [romaji, episodes],
      )
    ).rows[0]!.id;

  const call = (
    method: 'post' | 'put' | 'patch' | 'delete' | 'get',
    path: string,
    body?: object,
    as = auth,
  ) => {
    const req = request(t.app)[method](`/v1${path}`).set('Authorization', as);
    return body === undefined ? req : req.send(body);
  };
  const addEntry = async (status = 'watching', episodes: number | null = 12, as = auth) => {
    const response = await call(
      'post',
      '/library',
      { titleId: await newTitle(episodes), status },
      as,
    );
    expect(response.status).toBe(201);
    return response.body.data as { id: string; title: { id: string } };
  };
  const progress = (entryId: string, body: object, as = auth) =>
    call('post', `/library/${entryId}/progress`, body, as);

  describe('progress (FR-TRK-001, -002, -008)', () => {
    it('+1 counts an episode, answers with the entry and writes one event with its run', async () => {
      const entry = await addEntry();
      const response = await progress(entry.id, { delta: 1 });
      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({ progress: 1, status: 'watching' });
      expect(response.body.suggestComplete).toBe(false);
      const logged = (await events(entry.id)).at(-1)!;
      expect(logged).toMatchObject({
        type: 'progress_changed',
        payload: { from: 0, to: 1, run: 1 },
      });
      expect(logged.run_id).toBe(response.body.data.runs[0].id);
    });

    it('sets an absolute number, and one event records the whole jump', async () => {
      const entry = await addEntry();
      const response = await progress(entry.id, { set: 7 });
      expect(response.body.data.progress).toBe(7);
      expect((await events(entry.id)).at(-1)).toMatchObject({
        payload: { from: 0, to: 7, run: 1 },
      });
    });

    it('-1 undoes an episode, and the history shows both', async () => {
      const entry = await addEntry();
      await progress(entry.id, { delta: 1 });
      const back = await progress(entry.id, { delta: -1 });
      expect(back.body.data.progress).toBe(0);
      expect(
        (await eventTypes(entry.id)).filter((type) => type === 'progress_changed'),
      ).toHaveLength(2);
    });

    it('setting the number it already is writes nothing', async () => {
      const entry = await addEntry();
      await progress(entry.id, { set: 3 });
      const before = await events(entry.id);
      const same = await progress(entry.id, { set: 3 });
      expect(same.status).toBe(200);
      expect(await events(entry.id)).toEqual(before);
    });

    it.each([
      ['below zero', { delta: -1 }],
      ['a delta of 0', { delta: 0 }],
      ['both delta and set', { delta: 1, set: 2 }],
      ['neither', {}],
      ['a fraction', { delta: 1.5 }],
      ['a negative set', { set: -3 }],
      ['an unknown field', { delta: 1, extra: true }],
      ['a huge step', { delta: 1000 }],
    ])('refuses %s with 422 and changes nothing', async (_label, body) => {
      const entry = await addEntry();
      const before = await eventTypes(entry.id);
      expect((await progress(entry.id, body)).status).toBe(422);
      expect(await eventTypes(entry.id)).toEqual(before);
      expect((await call('get', `/library/${entry.id}`)).body.data.progress).toBe(0);
    });

    it('FR-TRK-004: the first episode of a Planned entry moves it to Watching and records the start', async () => {
      const entry = await addEntry('planned');
      expect(entry).toBeTruthy();
      const response = await progress(entry.id, { delta: 1 });
      expect(response.body.data.status).toBe('watching');
      expect(response.body.data.startedAt).toEqual(expect.any(String));
      const types = await events(entry.id);
      expect(types.map((event) => event.type).slice(-2)).toEqual([
        'progress_changed',
        'status_changed',
      ]);
      expect(types.at(-1)!.payload).toEqual({ from: 'planned', to: 'watching' });
    });

    it.each(['on_hold', 'dropped'])(
      'an episode of a %s entry picks it up again; undoing one does not',
      async (status) => {
        const entry = await addEntry(status);
        await progress(entry.id, { set: 5 });
        expect((await call('get', `/library/${entry.id}`)).body.data.status).toBe('watching');
        await call('patch', `/library/${entry.id}`, { status });
        await progress(entry.id, { delta: -1 });
        expect((await call('get', `/library/${entry.id}`)).body.data.status).toBe(status);
      },
    );

    it('FR-TRK-003: reaching the total suggests completing, and does not complete on its own', async () => {
      const entry = await addEntry('watching', 3);
      expect((await progress(entry.id, { set: 2 })).body.suggestComplete).toBe(false);
      const last = await progress(entry.id, { delta: 1 });
      expect(last.body).toMatchObject({ suggestComplete: true });
      expect(last.body.data.status).toBe('watching');
      // The user accepts: Completed closes the run and records the finish.
      const done = await call('patch', `/library/${entry.id}`, { status: 'completed' });
      expect(done.body.data).toMatchObject({ status: 'completed', progress: 3 });
      expect(done.body.data.completedAt).toEqual(expect.any(String));
      expect(done.body.data.runs[0]).toMatchObject({ progressAtEnd: 3 });
    });

    it('FR-TRK-007: never past a known total, and the answer says what the total is', async () => {
      const entry = await addEntry('watching', 12);
      const over = await progress(entry.id, { set: 13 });
      expect(over.status).toBe(422);
      expect(over.body).toMatchObject({ code: 'PROGRESS_EXCEEDS_TOTAL', total: 12 });
      expect((await progress(entry.id, { delta: 13 })).status).toBe(422);
      expect((await progress(entry.id, { set: 12 })).status).toBe(200);
      expect((await progress(entry.id, { delta: 1 })).body.code).toBe('PROGRESS_EXCEEDS_TOTAL');
      expect(await scalar('SELECT progress FROM library_entry WHERE id = $1', [entry.id])).toBe(12);
    });

    it('with no known total there is no ceiling (an airing show)', async () => {
      const entry = await addEntry('watching', null);
      const response = await progress(entry.id, { set: 500 });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ suggestComplete: false });
      expect(response.body.data.effectiveTotal).toBeNull();
    });

    it('a completed entry refuses progress with a pointer to rewatch', async () => {
      const entry = await addEntry('completed', 12);
      const response = await progress(entry.id, { delta: 1 });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('ENTRY_COMPLETED');
    });

    it('two taps at once count both (the entry is locked while it changes)', async () => {
      const entry = await addEntry('watching', 100);
      const responses = await Promise.all(
        Array.from({ length: 12 }, () => progress(entry.id, { delta: 1 })),
      );
      expect(responses.every((response) => response.status === 200)).toBe(true);
      expect(await scalar('SELECT progress FROM library_entry WHERE id = $1', [entry.id])).toBe(12);
      expect(
        (await eventTypes(entry.id)).filter((type) => type === 'progress_changed'),
      ).toHaveLength(12);
      const tos = (await events(entry.id))
        .filter((event) => event.type === 'progress_changed')
        .map((event) => event.payload['to']);
      expect(new Set(tos).size).toBe(12); // no two events claim the same result
    });
  });

  describe('episode count override (FR-TRK-005, -007)', () => {
    it('raises the ceiling, is visible as edited, and records where it came from', async () => {
      const entry = await addEntry('watching', 12);
      await progress(entry.id, { set: 12 });
      const response = await call('put', `/library/${entry.id}/episodes-total`, { total: 24 });
      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({ effectiveTotal: 24, totalOverridden: true });
      expect((await events(entry.id)).at(-1)).toMatchObject({
        type: 'total_overridden',
        payload: { from: 12, to: 24 },
      });
      expect((await progress(entry.id, { set: 24 })).status).toBe(200);
      expect((await progress(entry.id, { set: 25 })).body.total).toBe(24);
    });

    it('cannot go below what has been watched: refused, never clamped', async () => {
      const entry = await addEntry('watching', 12);
      await progress(entry.id, { set: 10 });
      const response = await call('put', `/library/${entry.id}/episodes-total`, { total: 8 });
      expect(response.status).toBe(422);
      expect(response.body).toMatchObject({ code: 'TOTAL_BELOW_PROGRESS', progress: 10 });
      expect((await call('get', `/library/${entry.id}`)).body.data).toMatchObject({
        progress: 10,
        effectiveTotal: 12,
        totalOverridden: false,
      });
    });

    it('lowering it is fine when progress allows, and the same value twice is a no-op', async () => {
      const entry = await addEntry('watching', 12);
      await progress(entry.id, { set: 3 });
      await call('put', `/library/${entry.id}/episodes-total`, { total: 6 });
      const before = await events(entry.id);
      await call('put', `/library/${entry.id}/episodes-total`, { total: 6 });
      expect(await events(entry.id)).toEqual(before);
      expect((await progress(entry.id, { set: 7 })).body.total).toBe(6);
    });

    it('resetting returns to the source count and records it; a reset with nothing set is a no-op', async () => {
      const entry = await addEntry('watching', 12);
      const none = await call('delete', `/library/${entry.id}/episodes-total`);
      expect(none.status).toBe(200);
      expect(await eventTypes(entry.id)).toEqual(['entry_added', 'run_started']);

      await call('put', `/library/${entry.id}/episodes-total`, { total: 24 });
      const reset = await call('delete', `/library/${entry.id}/episodes-total`);
      expect(reset.body.data).toMatchObject({ effectiveTotal: 12, totalOverridden: false });
      expect((await events(entry.id)).at(-1)).toMatchObject({
        type: 'total_override_cleared',
        payload: { from: 24, to: 12 },
      });
    });

    it('cannot be reset while progress is past the source count', async () => {
      const entry = await addEntry('watching', 12);
      await call('put', `/library/${entry.id}/episodes-total`, { total: 24 });
      await progress(entry.id, { set: 20 });
      const response = await call('delete', `/library/${entry.id}/episodes-total`);
      expect(response.status).toBe(422);
      expect(response.body.code).toBe('TOTAL_BELOW_PROGRESS');
      expect((await call('get', `/library/${entry.id}`)).body.data.totalOverridden).toBe(true);
    });

    it('gives a title with no known count one', async () => {
      const entry = await addEntry('watching', null);
      const response = await call('put', `/library/${entry.id}/episodes-total`, { total: 13 });
      expect(response.body.data).toMatchObject({ effectiveTotal: 13, totalOverridden: true });
      expect((await events(entry.id)).at(-1)).toMatchObject({ payload: { from: null, to: 13 } });
    });

    it.each([0, -1, 1.5, 100_001, '12', null])('refuses %j as a count with 422', async (total) => {
      const entry = await addEntry();
      expect((await call('put', `/library/${entry.id}/episodes-total`, { total })).status).toBe(
        422,
      );
    });
  });

  describe('ratings (FR-REM-001) and reviews (FR-REM-002)', () => {
    it('rates 1–10 and clears, one event each, with where it came from', async () => {
      const entry = await addEntry();
      expect((await call('patch', `/library/${entry.id}`, { rating: 7 })).body.data.rating).toBe(7);
      await call('patch', `/library/${entry.id}`, { rating: 9 });
      await call('patch', `/library/${entry.id}`, { rating: null });
      const rated = (await events(entry.id))
        .filter((event) => event.type === 'rated')
        .map((event) => event.payload);
      expect(rated).toEqual([
        { from: null, to: 7 },
        { from: 7, to: 9 },
        { from: 9, to: null },
      ]);
      expect((await call('get', `/library/${entry.id}`)).body.data.rating).toBeNull();
    });

    it('the same rating again writes nothing', async () => {
      const entry = await addEntry();
      await call('patch', `/library/${entry.id}`, { rating: 5 });
      const before = await events(entry.id);
      await call('patch', `/library/${entry.id}`, { rating: 5 });
      expect(await events(entry.id)).toEqual(before);
    });

    it.each([0, 11, -1, 5.5, '8', true])('refuses a rating of %j with 422', async (rating) => {
      const entry = await addEntry();
      expect((await call('patch', `/library/${entry.id}`, { rating })).status).toBe(422);
    });

    it('writes, edits and deletes a private review; the event keeps its length, never its text', async () => {
      const entry = await addEntry();
      const text = 'Slow start, wonderful ending. The score alone is not enough.';
      expect((await call('patch', `/library/${entry.id}`, { review: text })).body.data.review).toBe(
        text,
      );
      await call('patch', `/library/${entry.id}`, { review: `${text} Edited.` });
      expect(
        (await call('patch', `/library/${entry.id}`, { review: '   ' })).body.data.review,
      ).toBeNull();
      const reviewed = (await events(entry.id))
        .filter((event) => event.type === 'reviewed')
        .map((event) => event.payload);
      expect(reviewed).toEqual([
        { length: text.length },
        { length: text.length + 8 },
        { length: 0 },
      ]);
      expect(JSON.stringify(await events(entry.id))).not.toContain('wonderful');
    });

    it('refuses a review that is too long, and an unchanged one writes nothing', async () => {
      const entry = await addEntry();
      expect(
        (await call('patch', `/library/${entry.id}`, { review: 'x'.repeat(10_001) })).status,
      ).toBe(422);
      await call('patch', `/library/${entry.id}`, { review: 'same' });
      const before = await events(entry.id);
      await call('patch', `/library/${entry.id}`, { review: 'same' });
      expect(await events(entry.id)).toEqual(before);
    });

    it('is private: another user cannot read or change it', async () => {
      const entry = await addEntry();
      await call('patch', `/library/${entry.id}`, { review: 'secret', rating: 8 });
      const other = await t.signIn('reader');
      expect((await call('get', `/library/${entry.id}`, undefined, other.auth)).status).toBe(404);
      expect(
        (await call('patch', `/library/${entry.id}`, { review: 'overwritten' }, other.auth)).status,
      ).toBe(404);
      expect((await call('get', `/library/${entry.id}`)).body.data.review).toBe('secret');
    });
  });

  describe('rewatch (FR-REM-004, FR-REM-005)', () => {
    async function completedEntry(episodes = 12) {
      const entry = await addEntry('watching', episodes);
      await progress(entry.id, { set: episodes });
      await call('patch', `/library/${entry.id}`, { rating: 8 });
      await call('patch', `/library/${entry.id}`, { status: 'completed' });
      return entry;
    }

    it('starts run 2 and keeps run 1 exactly as it was', async () => {
      const entry = await completedEntry();
      const first = (await call('get', `/library/${entry.id}`)).body.data.runs[0];
      expect(first).toMatchObject({ runNumber: 1, progressAtEnd: 12, rating: 8 });

      const response = await call('post', `/library/${entry.id}/runs`);
      expect(response.status).toBe(201);
      expect(response.body.data).toMatchObject({
        status: 'watching',
        progress: 0,
        completedAt: null,
      });
      expect(response.body.data.runs).toHaveLength(2);
      expect(response.body.data.runs[0]).toEqual(first);
      expect(response.body.data.runs[1]).toMatchObject({
        runNumber: 2,
        finishedAt: null,
        rating: null,
        progressAtEnd: null,
      });
      const tail = (await events(entry.id)).slice(-3);
      expect(tail.map((event) => event.type)).toEqual([
        'status_changed',
        'progress_changed',
        'run_started',
      ]);
      expect(tail[1]!.payload).toEqual({ from: 12, to: 0, run: 2 });
    });

    it('only a completed entry can be rewatched', async () => {
      const entry = await addEntry('watching');
      const response = await call('post', `/library/${entry.id}/runs`);
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('NOT_COMPLETED');
      expect(await scalar('SELECT count(*) FROM viewing_run WHERE entry_id = $1', [entry.id])).toBe(
        1,
      );
    });

    it('progress and completion of the new run belong to the new run, and there is never more than one open run', async () => {
      const entry = await completedEntry(3);
      await call('post', `/library/${entry.id}/runs`);
      const response = await progress(entry.id, { delta: 1 });
      const second = response.body.data.runs[1];
      expect((await events(entry.id)).at(-1)).toMatchObject({
        type: 'progress_changed',
        payload: { from: 0, to: 1, run: 2 },
        run_id: second.id,
      });
      expect(
        await scalar(
          'SELECT count(*) FROM viewing_run WHERE entry_id = $1 AND finished_at IS NULL',
          [entry.id],
        ),
      ).toBe(1);

      await progress(entry.id, { set: 3 });
      const done = await call('patch', `/library/${entry.id}`, { status: 'completed' });
      expect(
        done.body.data.runs.map((run: { runNumber: number; progressAtEnd: number | null }) => [
          run.runNumber,
          run.progressAtEnd,
        ]),
      ).toEqual([
        [1, 3],
        [2, 3],
      ]);
      expect(
        await scalar(
          'SELECT count(*) FROM viewing_run WHERE entry_id = $1 AND finished_at IS NULL',
          [entry.id],
        ),
      ).toBe(0);

      // A third run is possible, and the numbering continues.
      const third = await call('post', `/library/${entry.id}/runs`);
      expect(third.body.data.runs.map((run: { runNumber: number }) => run.runNumber)).toEqual([
        1, 2, 3,
      ]);
    });

    it('rates each run separately (FR-REM-005): a new rating belongs to the run it was given in', async () => {
      const entry = await completedEntry();
      await call('post', `/library/${entry.id}/runs`);
      const rated = await call('patch', `/library/${entry.id}`, { rating: 10 });
      expect(rated.body.data.runs.map((run: { rating: number | null }) => run.rating)).toEqual([
        8, 10,
      ]);
    });

    it("is the owner's alone", async () => {
      const entry = await completedEntry();
      const other = await t.signIn('other');
      expect((await call('post', `/library/${entry.id}/runs`, undefined, other.auth)).status).toBe(
        404,
      );
      expect(await scalar('SELECT count(*) FROM viewing_run WHERE entry_id = $1', [entry.id])).toBe(
        1,
      );
    });
  });

  describe('history (FR-REM-003, FR-REM-007)', () => {
    async function activity() {
      const a = await addEntry('watching', 12);
      const b = await addEntry('planned', 24);
      await progress(a.id, { set: 3 });
      await call('patch', `/library/${a.id}`, { rating: 9, isFavorite: true });
      await progress(b.id, { delta: 1 });
      await call('delete', `/library/${b.id}`);
      return { a, b };
    }

    it("lists the user's events newest first, each with its title and what happened", async () => {
      const { a } = await activity();
      const response = await call('get', '/history?limit=100');
      expect(response.status).toBe(200);
      const types = (response.body.data as Array<{ type: string }>).map((item) => item.type);
      expect(types).toEqual([
        'entry_removed',
        'status_changed',
        'progress_changed',
        'rated',
        'favorited',
        'progress_changed',
        'run_started',
        'entry_added',
        'run_started',
        'entry_added',
      ]);
      const rated = response.body.data.find((item: { type: string }) => item.type === 'rated');
      expect(rated).toMatchObject({
        payload: { from: null, to: 9 },
        entryId: a.id,
        title: { id: a.title.id },
      });
      expect(rated.title.titleRomaji).toBe('Show');
      expect(response.headers['cache-control']).toBe('private, no-store');
    });

    it('keeps the events of a removed entry (the tombstone still has a target)', async () => {
      const { b } = await activity();
      const response = await call('get', `/history?titleId=${b.title.id}`);
      expect((response.body.data as Array<{ type: string }>).map((item) => item.type)).toEqual([
        'entry_removed',
        'status_changed',
        'progress_changed',
        'run_started',
        'entry_added',
      ]);
    });

    it('filters by type (one or several), by title and by period', async () => {
      const { a } = await activity();
      const rated = await call('get', '/history?type=rated');
      expect(rated.body.data).toHaveLength(1);
      const some = await call('get', '/history?type=rated,favorited');
      expect(some.body.data.map((item: { type: string }) => item.type)).toEqual([
        'rated',
        'favorited',
      ]);
      const byTitle = await call('get', `/history?titleId=${a.title.id}&type=progress_changed`);
      expect(byTitle.body.data).toHaveLength(1);

      const all = (await call('get', '/history?limit=100')).body.data as Array<{
        occurredAt: string;
      }>;
      const newest = all[0]!.occurredAt;
      const future = new Date(Date.parse(newest) + 60_000).toISOString();
      expect((await call('get', `/history?from=${encodeURIComponent(future)}`)).body.data).toEqual(
        [],
      );
      expect(
        (await call('get', `/history?to=${encodeURIComponent('2000-01-01T00:00:00Z')}`)).body.data,
      ).toEqual([]);
      expect(
        (
          await call(
            'get',
            `/history?from=${encodeURIComponent('2000-01-01T00:00:00Z')}&to=${encodeURIComponent(future)}&limit=100`,
          )
        ).body.data,
      ).toHaveLength(all.length);
    });

    it('pages with a keyset cursor: no gaps, no repeats, even while new events arrive', async () => {
      const entry = await addEntry('watching', 100);
      for (let i = 1; i <= 9; i += 1) await progress(entry.id, { delta: 1 });
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query: string = `/history?limit=4${cursor === null ? '' : `&cursor=${cursor}`}`;
        const body = (await call('get', query)).body;
        seen.push(...body.data.map((item: { id: string }) => item.id));
        if (pages === 0) await progress(entry.id, { delta: 1 }); // new activity between pages
        cursor = body.nextCursor;
        pages += 1;
      } while (cursor !== null);
      expect(seen).toHaveLength(new Set(seen).size);
      expect(seen).toHaveLength(11); // added + run_started + 9 episodes; the late one is not in this walk
    });

    it("shows only the caller's own events", async () => {
      await activity();
      const other = await t.signIn('other');
      expect((await call('get', '/history', undefined, other.auth)).body.data).toEqual([]);
    });

    it.each([
      '?type=nonsense',
      '?type=',
      '?titleId=abc',
      '?from=yesterday',
      '?to=2026-13-45',
      '?limit=0',
      '?limit=101',
      '?cursor=garbage',
      '?bogus=1',
    ])('refuses %s with 422', async (query) => {
      expect((await call('get', `/history${query}`)).status).toBe(422);
    });

    it('FR-REM-007: no route changes an event, and the database refuses stray SQL', async () => {
      const { a } = await activity();
      const item = (await call('get', '/history?limit=1')).body.data[0];
      for (const method of ['put', 'patch', 'delete', 'post'] as const) {
        expect((await call(method, `/history/${item.id}`, {})).status, method).toBe(404);
      }
      for (const statement of [
        `UPDATE event SET type = 'rated'`,
        `UPDATE event SET payload = '{}'`,
        `DELETE FROM event`,
      ]) {
        expect((await pgFailure(() => sql().query(statement))).code, statement).toBe('AKB01');
      }
      expect(
        await scalar('SELECT count(*) FROM event WHERE entry_id = $1', [a.id]),
      ).toBeGreaterThan(0);
    });

    it('needs a signed-in user', async () => {
      expect((await call('get', '/history', undefined, 'Bearer nope')).status).toBe(401);
    });
  });

  describe('IDOR for every tracking route (doc 11 §3.2)', () => {
    it("user B gets 404 and no side effects on user A's entry", async () => {
      const entry = await addEntry('watching', 12);
      const other = await t.signIn('intruder');
      const eventsBefore = await scalar('SELECT count(*) FROM event');
      const attempts = [
        call('post', `/library/${entry.id}/progress`, { delta: 1 }, other.auth),
        call('put', `/library/${entry.id}/episodes-total`, { total: 99 }, other.auth),
        call('delete', `/library/${entry.id}/episodes-total`, undefined, other.auth),
        call('post', `/library/${entry.id}/runs`, undefined, other.auth),
        call('patch', `/library/${entry.id}`, { rating: 1, review: 'x' }, other.auth),
      ];
      for (const attempt of attempts) expect((await attempt).status).toBe(404);
      expect(await scalar('SELECT count(*) FROM event')).toBe(eventsBefore);
      expect((await call('get', `/library/${entry.id}`)).body.data).toMatchObject({
        progress: 0,
        rating: null,
        totalOverridden: false,
      });
    });
  });

  describe('invariants hold under any sequence of operations (doc 11 §3.4)', () => {
    /** A small deterministic generator, so a failure can be replayed from its seed. */
    function prng(seed: number): () => number {
      let state = seed;
      return () => {
        state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
        return state / 4_294_967_296;
      };
    }

    async function assertInvariants(entryId: string, context: string): Promise<void> {
      const row = (
        await sql().query(
          `SELECT le.status, le.progress, le.episodes_total_override AS override, le.removed_at, t.episodes_total AS source
           FROM library_entry le JOIN title t ON t.id = le.title_id WHERE le.id = $1`,
          [entryId],
        )
      ).rows[0] as {
        status: string;
        progress: number;
        override: number | null;
        removed_at: Date | null;
        source: number | null;
      };
      const total = row.override ?? row.source;
      expect(row.progress, `${context}: progress >= 0`).toBeGreaterThanOrEqual(0);
      if (total !== null)
        expect(row.progress, `${context}: progress <= total`).toBeLessThanOrEqual(total);
      const open = await scalar(
        'SELECT count(*) FROM viewing_run WHERE entry_id = $1 AND finished_at IS NULL',
        [entryId],
      );
      expect(open, `${context}: at most one open run`).toBeLessThanOrEqual(1);
      if (row.removed_at === null && row.status !== 'completed')
        expect(open, `${context}: an active, unfinished entry has its run open`).toBe(1);
      if (row.status === 'completed' && row.removed_at === null)
        expect(open, `${context}: a completed entry has no open run`).toBe(0);
      // The state is what the events say: progress equals the last progress event of the entry.
      const last = (await events(entryId))
        .filter((event) => event.type === 'progress_changed')
        .at(-1);
      expect(row.progress, `${context}: progress agrees with the events`).toBe(
        last === undefined ? 0 : (last.payload['to'] as number),
      );
      // Run numbers are 1, 2, 3, … without gaps.
      const numbers = (
        await sql().query<{ run_number: number }>(
          'SELECT run_number FROM viewing_run WHERE entry_id = $1 ORDER BY run_number',
          [entryId],
        )
      ).rows.map((r) => r.run_number);
      expect(numbers, `${context}: run numbers`).toEqual(numbers.map((_, index) => index + 1));
    }

    it.each([1, 2, 3, 4, 5, 6])(
      'seed %i: 60 random operations',
      async (seed) => {
        const random = prng(seed * 7919);
        const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
        const titleId = await newTitle(seed % 3 === 0 ? null : 6);
        const created = await call('post', '/library', { titleId, status: 'watching' });
        const entryId = created.body.data.id as string;
        await assertInvariants(entryId, 'after add');

        let removed = false;
        for (let step = 1; step <= 60; step += 1) {
          const eventCount = await scalar('SELECT count(*) FROM event WHERE entry_id = $1', [
            entryId,
          ]);
          let response;
          let label: string;
          if (removed) {
            label = 're-add';
            response = await call('post', '/library', {
              titleId,
              status: pick(['watching', 'planned', 'completed']),
            });
            if (response.status === 201) removed = false;
          } else {
            const choice = pick([
              '+1',
              '+1',
              '+1',
              '-1',
              'set',
              'status',
              'override',
              'clear',
              'rate',
              'review',
              'fav',
              'rewatch',
              'remove',
            ]);
            label = choice;
            const base = `/library/${entryId}`;
            if (choice === '+1') response = await progress(entryId, { delta: 1 });
            else if (choice === '-1') response = await progress(entryId, { delta: -1 });
            else if (choice === 'set')
              response = await progress(entryId, { set: Math.floor(random() * 9) });
            else if (choice === 'status')
              response = await call('patch', base, {
                status: pick(['watching', 'completed', 'planned', 'on_hold', 'dropped']),
              });
            else if (choice === 'override')
              response = await call('put', `${base}/episodes-total`, {
                total: 1 + Math.floor(random() * 10),
              });
            else if (choice === 'clear') response = await call('delete', `${base}/episodes-total`);
            else if (choice === 'rate')
              response = await call('patch', base, { rating: pick([1, 5, 10, null]) });
            else if (choice === 'review')
              response = await call('patch', base, { review: pick(['good', 'meh', null]) });
            else if (choice === 'fav')
              response = await call('patch', base, { isFavorite: random() < 0.5 });
            else if (choice === 'rewatch') response = await call('post', `${base}/runs`);
            else {
              response = await call('delete', base);
              if (response.status === 204) removed = true;
            }
          }
          const context = `seed ${seed} step ${step} (${label}, ${response.status})`;
          // A refused request changes nothing; a successful one changes state only along with events.
          if (response.status >= 400) {
            expect([404, 409, 422], context).toContain(response.status);
          }
          expect(response.status, context).toBeLessThan(500);
          const after = await scalar('SELECT count(*) FROM event WHERE entry_id = $1', [entryId]);
          if (response.status >= 400)
            expect(after, `${context}: a refused request wrote events`).toBe(eventCount);
          await assertInvariants(entryId, context);
        }
      },
      120_000,
    );
  });
});
