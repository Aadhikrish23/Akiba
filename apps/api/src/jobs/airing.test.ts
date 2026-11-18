/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest response bodies are untyped JSON; this suite reads them field by field */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildCatalogTestApp,
  isAiringQuery,
  recordedAniList,
  type CatalogTestApp,
} from '../testing/catalog.js';
import { createTestDatabase, type TestDatabase } from '../testing/database.js';
import {
  fixture,
  fixtureResponse,
  jsonResponse,
  type RecordedRequest,
} from '../testing/sources.js';
import { syncAiring } from './airingSync.js';
import { FANOUT_MAX_AGE_MS, fanOutAiredEpisodes } from './inboxFanout.js';

/**
 * T23: the airing sync and the inbox fan-out (FR-NOTE-001, -002, -004, -005) on a real database.
 * The recorded AniList schedule has episode 8 of two shows: 195516 airs 2026-11-20T14:00Z and
 * 195604 airs 2026-11-21T14:00Z.
 */
const AIRS_A = new Date('2026-11-20T14:00:00.000Z');
const AIRS_B = new Date('2026-11-21T14:00:00.000Z');
const BEFORE = new Date('2026-11-19T09:00:00.000Z');
const AFTER_A = new Date('2026-11-20T15:00:00.000Z');
const AFTER_B = new Date('2026-11-21T15:00:00.000Z');

describe('airing sync and inbox fan-out (T23)', () => {
  let testDb: TestDatabase;
  let t: CatalogTestApp;

  beforeAll(async () => {
    testDb = await createTestDatabase();
  });
  afterAll(async () => {
    await testDb.drop();
  });

  /** What the mock AniList answers to the Airing query (replaceable per test). */
  let schedule: (request: RecordedRequest) => Response;
  const recordedSchedule = (): Response => fixtureResponse(fixture('anilist', 'airing-next-week'));
  beforeEach(async () => {
    await testDb.reset();
    schedule = recordedSchedule;
    t = await buildCatalogTestApp({
      db: testDb.db.client,
      anilist: (request) => (isAiringQuery(request) ? schedule(request) : recordedAniList(request)),
    });
  });

  const sql = () => testDb.sql;
  const scalar = async (text: string, values: unknown[] = []): Promise<number> =>
    Number(Object.values((await sql().query(text, values)).rows[0] as object)[0]);
  const airingRequests = () => t.anilist.requests.filter((r) => isAiringQuery(r));

  async function newTitle(anilistId: string | null, status = 'releasing'): Promise<string> {
    const id = (
      await sql().query<{ id: string }>(
        `INSERT INTO title (kind, status, title_romaji, episodes_total, fetched_at, detail_fetched_at)
         VALUES ('tv', $1::title_status, $2, 12, now(), now()) RETURNING id`,
        [status, `Show ${anilistId ?? 'none'}`],
      )
    ).rows[0]!.id;
    if (anilistId !== null) {
      await sql().query(
        `INSERT INTO title_external_id (title_id, source, external_id) VALUES ($1, 'anilist', $2)`,
        [id, anilistId],
      );
    }
    return id;
  }

  /** A signed-in user who has `titleId` on their shelf as Watching. */
  async function watcher(titleId: string | null, label = 'watcher') {
    const user = await t.signIn(label);
    let entryId: string | undefined;
    if (titleId !== null) {
      const added = await request(t.app)
        .post('/v1/library')
        .set('Authorization', user.auth)
        .send({ titleId, status: 'watching' });
      expect(added.status).toBe(201);
      entryId = added.body.data.id as string;
    }
    return { ...user, entryId };
  }
  const setGlobalAlerts = (auth: string, alertsEnabled: boolean) =>
    request(t.app).patch('/v1/me').set('Authorization', auth).send({ alertsEnabled });
  const setEntryAlerts = (auth: string, entryId: string, alertsEnabled: boolean | null) =>
    request(t.app)
      .patch(`/v1/library/${entryId}`)
      .set('Authorization', auth)
      .send({ alertsEnabled });

  const sync = (now: Date) =>
    syncAiring({ db: testDb.db.client, gateway: t.gateway, now, logger: t.logger });
  const fanOut = (now: Date) => fanOutAiredEpisodes({ db: testDb.db.client, now });
  const notificationsFor = async (userId: string): Promise<number> =>
    scalar('SELECT count(*) FROM notification WHERE user_id = $1', [userId]);

  describe('airing-sync', () => {
    it('asks only about titles somebody is watching, and stores their episodes', async () => {
      const a = await newTitle('195516');
      const b = await newTitle('195604');
      await newTitle('21'); // on nobody's shelf: never asked about
      await watcher(a);
      await watcher(b, 'second');

      const result = await sync(BEFORE);
      expect(result).toMatchObject({
        titles: 2,
        created: 2,
        rescheduled: 0,
        sourcesUnavailable: false,
      });
      const asked = airingRequests();
      expect(asked).toHaveLength(1);
      expect([...(asked[0]!.body!['variables'] as { ids: number[] }).ids].sort()).toEqual([
        195516, 195604,
      ]);
      const rows = (
        await sql().query<{
          title_id: string;
          episode_number: number;
          airs_at: Date;
          source: string;
        }>(`SELECT title_id, episode_number, airs_at, source FROM airing_episode ORDER BY airs_at`)
      ).rows;
      expect(
        rows.map((row) => [
          row.title_id,
          row.episode_number,
          row.airs_at.toISOString(),
          row.source,
        ]),
      ).toEqual([
        [a, 8, AIRS_A.toISOString(), 'anilist'],
        [b, 8, AIRS_B.toISOString(), 'anilist'],
      ]);
    });

    it('is idempotent: a second run changes nothing', async () => {
      await watcher(await newTitle('195516'));
      expect((await sync(BEFORE)).created).toBe(1);
      const again = await sync(BEFORE);
      expect(again).toMatchObject({ created: 0, rescheduled: 0 });
      expect(await scalar('SELECT count(*) FROM airing_episode')).toBe(1);
    });

    it('moves an episode whose time changed, keeping its row', async () => {
      await watcher(await newTitle('195516'));
      await sync(BEFORE);
      const id = (await sql().query<{ id: string }>('SELECT id FROM airing_episode')).rows[0]!.id;
      schedule = () => {
        const moved = structuredClone(fixture('anilist', 'airing-next-week'));
        const page = (
          moved.response as { data: { Page: { airingSchedules: { airingAt: number }[] } } }
        ).data.Page;
        for (const slot of page.airingSchedules) slot.airingAt += 3600;
        return fixtureResponse(moved);
      };
      expect(await sync(BEFORE)).toMatchObject({ created: 0, rescheduled: 1 });
      const row = (
        await sql().query<{ id: string; airs_at: Date }>('SELECT id, airs_at FROM airing_episode')
      ).rows[0]!;
      expect(row.id).toBe(id);
      expect(row.airs_at.toISOString()).toBe(new Date(AIRS_A.getTime() + 3_600_000).toISOString());
    });

    it('does not ask when nothing qualifies: not watching, removed, deleted account, finished, no AniList ID', async () => {
      const planned = await newTitle('195516');
      const user = await t.signIn('planner');
      await request(t.app)
        .post('/v1/library')
        .set('Authorization', user.auth)
        .send({ titleId: planned, status: 'planned' });
      const removed = await newTitle('195604');
      const gone = await watcher(removed, 'remover');
      await request(t.app).delete(`/v1/library/${gone.entryId}`).set('Authorization', gone.auth);
      const finished = await newTitle('1', 'finished');
      await watcher(finished, 'finished');
      const noId = await newTitle(null);
      await watcher(noId, 'noid');
      const dead = await newTitle('2');
      const leaver = await watcher(dead, 'leaver');
      await sql().query('UPDATE "user" SET deleted_at = now() WHERE id = $1', [leaver.userId]);

      expect(await sync(BEFORE)).toMatchObject({ titles: 0, created: 0 });
      expect(airingRequests()).toHaveLength(0);
    });

    it('says so, and writes nothing, when AniList cannot be reached', async () => {
      await watcher(await newTitle('195516'));
      schedule = () => jsonResponse(503, {});
      const result = await sync(BEFORE);
      expect(result).toMatchObject({ sourcesUnavailable: true, created: 0 });
      expect(await scalar('SELECT count(*) FROM airing_episode')).toBe(0);
      // And the next run, with the source back, fills it in.
      schedule = recordedSchedule;
      expect((await sync(BEFORE)).created).toBe(1);
    });
  });

  describe('inbox-fanout (FR-NOTE-001, FR-NOTE-002, FR-NOTE-004)', () => {
    it('notifies each user watching the title once an episode has aired, and nobody else', async () => {
      const a = await newTitle('195516');
      const b = await newTitle('195604');
      const watching = await watcher(a, 'one');
      const alsoWatching = await watcher(a, 'two');
      const otherShow = await watcher(b, 'three');
      const planner = await t.signIn('planner');
      await request(t.app)
        .post('/v1/library')
        .set('Authorization', planner.auth)
        .send({ titleId: a, status: 'planned' });
      const nothing = await watcher(null, 'empty');
      await sync(BEFORE);

      expect(await fanOut(BEFORE)).toEqual({ episodes: 0, notifications: 0, expired: 0 }); // not yet aired
      expect(await fanOut(AFTER_A)).toEqual({ episodes: 1, notifications: 2, expired: 0 });
      expect(await notificationsFor(watching.userId)).toBe(1);
      expect(await notificationsFor(alsoWatching.userId)).toBe(1);
      expect(await notificationsFor(otherShow.userId)).toBe(0); // their episode has not aired yet
      expect(await notificationsFor(planner.userId)).toBe(0); // only Watching counts
      expect(await notificationsFor(nothing.userId)).toBe(0);

      expect(await fanOut(AFTER_B)).toEqual({ episodes: 1, notifications: 1, expired: 0 });
      expect(await notificationsFor(otherShow.userId)).toBe(1);
    });

    it('is idempotent and never creates two for one user and episode', async () => {
      const a = await newTitle('195516');
      const user = await watcher(a);
      await sync(BEFORE);
      await fanOut(AFTER_A);
      expect(await fanOut(AFTER_A)).toEqual({ episodes: 0, notifications: 0, expired: 0 });
      expect(await notificationsFor(user.userId)).toBe(1);
      expect(
        await scalar('SELECT count(*) FROM airing_episode WHERE aired_processed_at IS NOT NULL'),
      ).toBe(1);
    });

    it('simultaneous runs handle each episode once and create each notification once', async () => {
      const a = await newTitle('195516');
      const b = await newTitle('195604');
      const users = [];
      for (let i = 0; i < 6; i += 1) users.push(await watcher(i % 2 === 0 ? a : b, `racer${i}`));
      await sync(BEFORE);
      const results = await Promise.all([1, 2, 3, 4].map(() => fanOut(AFTER_B)));
      expect(results.reduce((sum, r) => sum + r.episodes, 0)).toBe(2);
      expect(results.reduce((sum, r) => sum + r.notifications, 0)).toBe(6);
      expect(await scalar('SELECT count(*) FROM notification')).toBe(6);
      for (const user of users) expect(await notificationsFor(user.userId)).toBe(1);
    });

    it('respects alert settings: the entry’s own setting wins over the account’s', async () => {
      const a = await newTitle('195516');
      const defaults = await watcher(a, 'defaults'); // account on, entry unset → notified
      const accountOff = await watcher(a, 'accountoff');
      await setGlobalAlerts(accountOff.auth, false); // account off, entry unset → not notified
      const entryOff = await watcher(a, 'entryoff');
      await setEntryAlerts(entryOff.auth, entryOff.entryId!, false); // entry off → not notified
      const entryOn = await watcher(a, 'entryon');
      await setGlobalAlerts(entryOn.auth, false);
      await setEntryAlerts(entryOn.auth, entryOn.entryId!, true); // account off, entry on → notified
      await sync(BEFORE);
      await fanOut(AFTER_A);
      expect(await notificationsFor(defaults.userId)).toBe(1);
      expect(await notificationsFor(accountOff.userId)).toBe(0);
      expect(await notificationsFor(entryOff.userId)).toBe(0);
      expect(await notificationsFor(entryOn.userId)).toBe(1);
    });

    it('skips removed entries and accounts in their deletion grace period', async () => {
      const a = await newTitle('195516');
      const removed = await watcher(a, 'removed');
      await request(t.app)
        .delete(`/v1/library/${removed.entryId}`)
        .set('Authorization', removed.auth);
      const leaving = await watcher(a, 'leaving');
      await sql().query('UPDATE "user" SET deleted_at = now() WHERE id = $1', [leaving.userId]);
      const staying = await watcher(a, 'staying');
      await sync(BEFORE);
      expect(await fanOut(AFTER_A)).toMatchObject({ notifications: 1 });
      expect(await notificationsFor(staying.userId)).toBe(1);
      expect(await notificationsFor(removed.userId)).toBe(0);
      expect(await notificationsFor(leaving.userId)).toBe(0);
    });

    it('a deleted notification stays deleted; the next episode makes a new one', async () => {
      const a = await newTitle('195516');
      const user = await watcher(a);
      await sync(BEFORE);
      await fanOut(AFTER_A);
      await sql().query('DELETE FROM notification WHERE user_id = $1', [user.userId]);
      await fanOut(AFTER_A);
      expect(await notificationsFor(user.userId)).toBe(0);
      await sql().query(
        `INSERT INTO airing_episode (title_id, episode_number, airs_at, source) VALUES ($1, 9, $2, 'anilist')`,
        [a, new Date(AIRS_A.getTime() + 7 * 86_400_000)],
      );
      await fanOut(new Date(AFTER_A.getTime() + 7 * 86_400_000));
      expect(await notificationsFor(user.userId)).toBe(1);
    });

    it('an episode that aired too long ago is marked handled without telling anyone', async () => {
      const a = await newTitle('195516');
      const user = await watcher(a);
      await sync(BEFORE);
      const late = new Date(AIRS_A.getTime() + FANOUT_MAX_AGE_MS + 3_600_000);
      expect(await fanOut(late)).toEqual({ episodes: 1, notifications: 0, expired: 1 });
      expect(await notificationsFor(user.userId)).toBe(0);
      expect(await fanOut(late)).toMatchObject({ episodes: 0 }); // and not looked at again
    });

    it('is all or nothing: a failure part-way leaves no notifications and no handled episodes', async () => {
      const a = await newTitle('195516');
      const b = await newTitle('195604');
      await watcher(a, 'x');
      await watcher(b, 'y');
      await sync(BEFORE);
      await sql().query(`
        CREATE FUNCTION t23_fail() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.title_id = '${b}'::uuid THEN RAISE EXCEPTION 'injected failure'; END IF;
          RETURN NEW;
        END $$`);
      await sql().query(
        `CREATE TRIGGER t23_fail BEFORE INSERT ON notification FOR EACH ROW EXECUTE FUNCTION t23_fail()`,
      );
      await expect(fanOut(AFTER_B)).rejects.toThrow();
      expect(await scalar('SELECT count(*) FROM notification')).toBe(0);
      expect(
        await scalar('SELECT count(*) FROM airing_episode WHERE aired_processed_at IS NOT NULL'),
      ).toBe(0);
      await sql().query('DROP TRIGGER t23_fail ON notification');
      expect(await fanOut(AFTER_B)).toMatchObject({ episodes: 2, notifications: 2 });
      await sql().query('DROP FUNCTION t23_fail()');
    });

    it('FR-NOTE-005: sends no email and calls no source', async () => {
      const a = await newTitle('195516');
      await watcher(a);
      await t.settle();
      const sent = t.emails.sent.length;
      const asked = t.anilist.requests.length;
      await sync(BEFORE);
      const afterSync = t.anilist.requests.length;
      await fanOut(AFTER_A);
      await t.settle();
      expect(t.emails.sent.length).toBe(sent);
      expect(t.anilist.requests.length).toBe(afterSync); // the fan-out itself asked nobody
      expect(afterSync).toBeGreaterThan(asked);
    });
  });
});
