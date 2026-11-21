/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest response bodies are untyped JSON; this suite reads them field by field */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../lib/logger.js';
import {
  buildCatalogTestApp,
  isAiringQuery,
  recordedAniList,
  type CatalogTestApp,
} from '../testing/catalog.js';
import { createTestDatabase, type TestDatabase } from '../testing/database.js';
import { LogSink } from '../testing/harness.js';
import { fixture, fixtureResponse, jsonResponse } from '../testing/sources.js';
import { createJobScheduler } from './index.js';
import { createScheduler, type Job, type Timers } from './scheduler.js';

/** Timers the test fires by hand. */
class FakeTimers implements Timers {
  readonly pending = new Map<number, { callback: () => void; ms: number }>();
  #next = 1;
  setTimeout(callback: () => void, ms: number): unknown {
    const handle = this.#next++;
    this.pending.set(handle, { callback, ms });
    return handle;
  }
  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  /** Fire the oldest pending timer; resolves with the delay it had. */
  fireFirst(): number {
    const [handle, entry] = [...this.pending.entries()][0]!;
    this.pending.delete(handle);
    entry.callback();
    return entry.ms;
  }
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 50));
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

describe('scheduler (T23): locking, failures, timing', () => {
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await createTestDatabase();
  });
  afterAll(async () => {
    await testDb.drop();
  });

  const logger = createLogger({ level: 'silent', destination: new LogSink() });
  const make = (jobs: Job[], timers?: Timers) =>
    createScheduler({
      db: testDb.db.client,
      logger,
      jobs,
      random: () => 0,
      ...(timers === undefined ? {} : { timers }),
    });

  it('runs a job and reports what it did', async () => {
    const scheduler = make([
      { name: 'job', everyMs: 1000, run: () => Promise.resolve({ done: 3 }) },
    ]);
    expect(await scheduler.runNow('job')).toMatchObject({ status: 'ran', result: { done: 3 } });
    await expect(scheduler.runNow('nope')).rejects.toThrow('unknown job');
  });

  it('a failing job is reported, never thrown, and the others still run', async () => {
    const scheduler = make([
      { name: 'bad', everyMs: 1000, run: () => Promise.reject(new Error('boom')) },
      { name: 'good', everyMs: 1000, run: () => Promise.resolve({}) },
    ]);
    expect(await scheduler.runNow('bad')).toMatchObject({ status: 'failed' });
    expect(await scheduler.runNow('good')).toMatchObject({ status: 'ran' });
    // The lock is not left behind by the failure: the same job can run again.
    expect(await scheduler.runNow('bad')).toMatchObject({ status: 'failed' });
  });

  it('only one process runs a job at a time (advisory lock), and the lock frees when it ends', async () => {
    const hold = gate();
    let runs = 0;
    const job = (): Job => ({
      name: 'exclusive',
      everyMs: 1000,
      run: async () => {
        runs += 1;
        await hold.promise;
        return { ok: true };
      },
    });
    // Two schedulers stand for two API processes sharing one database.
    const first = make([job()]);
    const second = make([job()]);
    const running = first.runNow('exclusive');
    await settle(); // the first holds its lock now
    expect(await second.runNow('exclusive')).toEqual({ status: 'locked' });
    expect(await first.runNow('exclusive')).toEqual({ status: 'locked' }); // not on top of itself either
    expect(runs).toBe(1);
    hold.release();
    expect(await running).toMatchObject({ status: 'ran' });
    expect(await second.runNow('exclusive')).toMatchObject({ status: 'ran' });
    expect(runs).toBe(2);
  });

  it('different jobs do not block one another', async () => {
    const hold = gate();
    const scheduler = make([
      { name: 'slow', everyMs: 1000, run: async () => (await hold.promise, {}) },
      { name: 'quick', everyMs: 1000, run: () => Promise.resolve({}) },
    ]);
    const slow = scheduler.runNow('slow');
    await settle();
    expect(await scheduler.runNow('quick')).toMatchObject({ status: 'ran' });
    hold.release();
    await slow;
  });

  it('start schedules each job after its own delay, then at its interval; stop clears everything', async () => {
    const timers = new FakeTimers();
    let aRuns = 0;
    const scheduler = make(
      [
        {
          name: 'a',
          everyMs: 900,
          firstRunAfterMs: 100,
          run: () => Promise.resolve({ n: ++aRuns }),
        },
        { name: 'b', everyMs: 5000, firstRunAfterMs: 200, run: () => Promise.resolve({}) },
      ],
      timers,
    );
    scheduler.start();
    scheduler.start(); // a second start changes nothing
    expect([...timers.pending.values()].map((entry) => entry.ms).sort((x, y) => x - y)).toEqual([
      100, 200,
    ]);
    expect(timers.fireFirst()).toBe(100);
    await settle();
    expect(aRuns).toBe(1);
    // Rescheduled at its interval.
    expect([...timers.pending.values()].map((entry) => entry.ms).sort((x, y) => x - y)).toEqual([
      200, 900,
    ]);
    await scheduler.stop();
    expect(timers.pending.size).toBe(0);
  });

  it('stop waits for a run in progress, and nothing is scheduled after it', async () => {
    const timers = new FakeTimers();
    const hold = gate();
    let finished = false;
    const scheduler = make(
      [
        {
          name: 'long',
          everyMs: 1000,
          firstRunAfterMs: 1,
          run: async () => {
            await hold.promise;
            finished = true;
            return {};
          },
        },
      ],
      timers,
    );
    scheduler.start();
    timers.fireFirst();
    await settle();
    const stopping = scheduler.stop(60_000);
    await settle();
    expect(finished).toBe(false);
    hold.release();
    await stopping;
    expect(finished).toBe(true);
    await settle();
    expect(timers.pending.size).toBe(0); // the finished run did not schedule another
  });
});

/** The real job list, end to end: airing-sync, inbox-fanout, metadata-refresh, account-cleanup. */
describe('the jobs (T23)', () => {
  let testDb: TestDatabase;
  let t: CatalogTestApp;
  const NOW = new Date('2026-11-20T15:00:00.000Z'); // an hour after episode 8 of 195516

  beforeAll(async () => {
    testDb = await createTestDatabase();
  });
  afterAll(async () => {
    await testDb.drop();
  });
  beforeEach(async () => {
    await testDb.reset();
    t = await buildCatalogTestApp({
      db: testDb.db.client,
      anilist: (request) =>
        isAiringQuery(request)
          ? fixtureResponse(fixture('anilist', 'airing-next-week'))
          : recordedAniList(request),
    });
  });

  const scheduler = () =>
    createJobScheduler({
      db: testDb.db.client,
      gateway: t.gateway,
      titles: t.titles,
      logger: t.logger,
      now: () => NOW,
    });
  const sql = () => testDb.sql;

  it('airing-sync learns the schedule, announces what has aired, and shows up in the inbox', async () => {
    const title = (
      await sql().query<{ id: string }>(
        `INSERT INTO title (kind, status, title_romaji, episodes_total, fetched_at, detail_fetched_at)
         VALUES ('tv', 'releasing', 'Airing Show', 12, now(), now()) RETURNING id`,
      )
    ).rows[0]!.id;
    await sql().query(
      `INSERT INTO title_external_id (title_id, source, external_id) VALUES ($1, 'anilist', '195516')`,
      [title],
    );
    const user = await t.signIn('inboxer');
    await request(t.app)
      .post('/v1/library')
      .set('Authorization', user.auth)
      .send({ titleId: title, status: 'watching' });

    const outcome = await scheduler().runNow('airing-sync');
    expect(outcome).toMatchObject({
      status: 'ran',
      result: { titles: 1, created: 1, episodes: 1, notifications: 1 },
    });
    const inbox = await t.get('/inbox', user.auth);
    expect(inbox.status).toBe(200);
    expect(inbox.body.data).toHaveLength(1);
    expect(inbox.body.data[0]).toMatchObject({
      kind: 'episode_aired',
      readAt: null,
      episode: { number: 8, airsAt: '2026-11-20T14:00:00.000Z' },
      title: { id: title, titleRomaji: 'Airing Show', libraryStatus: 'watching' },
    });
    // A second run, and the other fan-out job, add nothing.
    expect(await scheduler().runNow('airing-sync')).toMatchObject({
      result: { created: 0, episodes: 0, notifications: 0 },
    });
    expect(await scheduler().runNow('inbox-fanout')).toMatchObject({
      result: { episodes: 0, notifications: 0 },
    });
    expect((await t.get('/inbox/unread-count', user.auth)).body).toEqual({ data: { count: 1 } });
  });

  it('metadata-refresh re-reads shelved titles whose copy is old, oldest first, within its budget', async () => {
    const user = await t.signIn('shelver');
    const search = await t.get('/titles/search?q=attack%20on%20titan&limit=3', user.auth);
    const ids = (search.body.data as { id: string }[]).map((card) => card.id);
    for (const id of ids) {
      await request(t.app)
        .post('/v1/library')
        .set('Authorization', user.auth)
        .send({ titleId: id, status: 'planned' });
    }
    const stranger = (
      await sql().query<{ id: string }>(
        `INSERT INTO title (kind, status, title_romaji, fetched_at) VALUES ('tv', 'finished', 'Not on a shelf', now()) RETURNING id`,
      )
    ).rows[0]!.id;
    await sql().query(`UPDATE title SET detail_fetched_at = NULL`);

    const outcome = await scheduler().runNow('metadata-refresh');
    expect(outcome.status).toBe('ran');
    const result = (outcome as { result: Record<string, number> }).result;
    expect(result['candidates']).toBe(3); // the shelved ones only
    expect((result['refreshed'] as number) + (result['failed'] as number)).toBe(3);
    const detailed = await sql().query(
      `SELECT id FROM title WHERE detail_fetched_at IS NOT NULL AND id = ANY($1)`,
      [ids],
    );
    expect(detailed.rows.length).toBeGreaterThanOrEqual(1);
    expect(
      (await sql().query(`SELECT detail_fetched_at FROM title WHERE id = $1`, [stranger])).rows[0]!
        .detail_fetched_at,
    ).toBeNull();
    // Fresh copies are left alone on the next run.
    t.time.advance(60_000);
    const again = (await scheduler().runNow('metadata-refresh')) as {
      result: Record<string, number>;
    };
    expect(again.result['candidates']).toBeLessThan(3);
  });

  it('metadata-refresh stops quietly when no source can answer', async () => {
    const user = await t.signIn('offline');
    const search = await t.get('/titles/search?q=attack%20on%20titan&limit=1', user.auth);
    const id = search.body.data[0].id as string;
    await request(t.app)
      .post('/v1/library')
      .set('Authorization', user.auth)
      .send({ titleId: id, status: 'planned' });
    await sql().query(`UPDATE title SET detail_fetched_at = NULL WHERE id = $1`, [id]);
    t.anilist.responder = () => jsonResponse(503, {});
    t.jikan.responder = () => jsonResponse(503, {});
    expect(await scheduler().runNow('metadata-refresh')).toMatchObject({
      status: 'ran',
      result: { candidates: 1, refreshed: 0, stopped: true },
    });
  });

  it('account-cleanup purges what has expired and reports the counts', async () => {
    const gone = await t.signIn('goner');
    await sql().query(`UPDATE "user" SET deleted_at = $2, purge_after = $2 WHERE id = $1`, [
      gone.userId,
      new Date(NOW.getTime() - 86_400_000),
    ]);
    const kept = await t.signIn('keeper');
    const outcome = await scheduler().runNow('account-cleanup');
    expect(outcome).toMatchObject({ status: 'ran', result: { accounts: 1 } });
    expect(Object.keys((outcome as { result: object }).result).sort()).toEqual([
      'accounts',
      'oneTimeTokens',
      'refreshTokens',
    ]);
    expect(
      Number(
        (await sql().query('SELECT count(*) FROM "user" WHERE id = $1', [kept.userId])).rows[0]!
          .count,
      ),
    ).toBe(1);
  });

  it('lists the jobs of doc 05 §7 that are wired', () => {
    expect(scheduler().jobs).toEqual([
      'airing-sync',
      'inbox-fanout',
      'metadata-refresh',
      'account-cleanup',
    ]);
  });
});
