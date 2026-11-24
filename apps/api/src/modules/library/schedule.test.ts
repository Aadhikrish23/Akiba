/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment -- supertest response bodies are untyped JSON; this suite reads them field by field */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildCatalogTestApp, type CatalogTestApp } from '../../testing/catalog.js';
import { createTestDatabase, type TestDatabase } from '../../testing/database.js';

const DAY = 86_400_000;
interface Slot {
  title: { titleRomaji: string };
  episode: number;
  projected: boolean;
  airsAt: string;
}
const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * The week of the shows you follow (`GET /library/schedule`): announced air times, the weekly run
 * carried forward as `projected`, the viewer's own watched state, and nobody else's data.
 */
describe('library schedule API', () => {
  let testDb: TestDatabase;
  let t: CatalogTestApp;
  let auth: string;

  // The library module runs on the real clock, so the week is built from it: today 00:00 UTC.
  const NOW = Date.now();
  const WEEK_START = NOW - (NOW % DAY);

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
  const newTitle = async (
    romaji: string,
    options: { status?: string; episodes?: number | null } = {},
  ): Promise<string> =>
    (
      await sql().query<{ id: string }>(
        `INSERT INTO title (kind, status, title_romaji, episodes_total, fetched_at, detail_fetched_at)
         VALUES ('tv', $1::title_status, $2, $3, now(), now()) RETURNING id`,
        [
          options.status ?? 'releasing',
          romaji,
          options.episodes === undefined ? 12 : options.episodes,
        ],
      )
    ).rows[0]!.id;
  const airs = async (titleId: string, episode: number, at: number): Promise<void> => {
    await sql().query(
      `INSERT INTO airing_episode (title_id, episode_number, airs_at, source) VALUES ($1, $2, $3, 'anilist')`,
      [titleId, episode, iso(at)],
    );
  };
  const add = (titleId: string, status = 'watching', as = auth) =>
    request(t.app).post('/v1/library').set('Authorization', as).send({ titleId, status });
  const schedule = (from: number, to: number, as = auth) =>
    t.get(
      `/library/schedule?from=${encodeURIComponent(iso(from))}&to=${encodeURIComponent(iso(to))}`,
      as,
    );

  it('lists announced episodes of watched and planned titles inside the window, in time order', async () => {
    const kusuriya = await newTitle('Kusuriya');
    const hotaru = await newTitle('Hotaru');
    const early = await newTitle('Early bird');
    await add(kusuriya, 'watching');
    await add(hotaru, 'planned');
    await add(early, 'watching');
    await airs(kusuriya, 8, WEEK_START + 1 * DAY + 13 * 3_600_000);
    await airs(hotaru, 8, WEEK_START + 2 * DAY + 14 * 3_600_000);
    await airs(early, 3, WEEK_START + 3_600_000);

    const response = await schedule(WEEK_START, WEEK_START + 7 * DAY);
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body.data.map((slot: Slot) => [slot.title.titleRomaji, slot.episode])).toEqual([
      ['Early bird', 3],
      ['Kusuriya', 8],
      ['Hotaru', 8],
    ]);
    expect(response.body.data[2]).toMatchObject({ entryStatus: 'planned', projected: false });
  });

  it('leaves out titles that are not on the shelf as Watching or Planned', async () => {
    const done = await newTitle('Finished', { status: 'finished' });
    const dropped = await newTitle('Dropped');
    const stranger = await newTitle('Not mine');
    await add(done, 'completed');
    await add(dropped, 'dropped');
    await airs(done, 1, WEEK_START + DAY);
    await airs(dropped, 1, WEEK_START + DAY);
    await airs(stranger, 1, WEEK_START + DAY);
    const response = await schedule(WEEK_START, WEEK_START + 7 * DAY);
    expect(response.body.data).toEqual([]);
  });

  it('marks what you have already watched in the current run', async () => {
    const show = await newTitle('Show');
    const entry = (await add(show)).body.data.id;
    await airs(show, 3, WEEK_START + DAY);
    await request(t.app)
      .post(`/v1/library/${entry}/progress`)
      .set('Authorization', auth)
      .send({ set: 3 });
    const response = await schedule(WEEK_START, WEEK_START + 7 * DAY);
    expect(response.body.data[0]).toMatchObject({ episode: 3, watched: true, progress: 3 });
  });

  it('carries a weekly run forward as projected slots, up to the last episode', async () => {
    const show = await newTitle('Weekly', { episodes: 11 });
    await add(show);
    // The latest announced episode aired this Tuesday.
    await airs(show, 8, WEEK_START + 1 * DAY + 13 * 3_600_000);
    const first = await schedule(WEEK_START + 7 * DAY, WEEK_START + 21 * DAY);
    expect(first.body.data.map((slot: Slot) => [slot.episode, slot.projected])).toEqual([
      [9, true],
      [10, true],
    ]);
    expect(first.body.data[0].airsAt).toBe(iso(WEEK_START + 8 * DAY + 13 * 3_600_000));
    // Episode 11 is the last: nothing is projected after it.
    const later = await schedule(WEEK_START + 21 * DAY, WEEK_START + 35 * DAY);
    expect(later.body.data.map((slot: Slot) => slot.episode)).toEqual([11]);
  });

  it('serves a whole month grid in one request (six weeks)', async () => {
    const show = await newTitle('Month', { episodes: null });
    await add(show);
    await airs(show, 8, WEEK_START + 1 * DAY + 13 * 3_600_000);
    const response = await schedule(WEEK_START, WEEK_START + 42 * DAY + 6 * 3_600_000);
    expect(response.status).toBe(200);
    // The announced episode, then one a week for the next five weeks.
    expect(response.body.data.map((slot: Slot) => slot.episode)).toEqual([8, 9, 10, 11, 12, 13]);
  });

  it('carries a weekly run forward to a window months away, with the right episode numbers', async () => {
    const show = await newTitle('Far ahead', { episodes: null });
    await add(show);
    await airs(show, 8, WEEK_START + 1 * DAY + 13 * 3_600_000);
    // Twenty weeks on: the Tuesday is 20 weeks after the announced one, so it is episode 28.
    const from = WEEK_START + 20 * 7 * DAY;
    const response = await schedule(from, from + 7 * DAY);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0]).toMatchObject({ episode: 28, projected: true });
    expect(response.body.data[0].airsAt).toBe(
      iso(WEEK_START + (20 * 7 + 1) * DAY + 13 * 3_600_000),
    );
  });

  it('stops carrying a run forward after three years', async () => {
    const show = await newTitle('Endless', { episodes: null });
    await add(show);
    await airs(show, 8, WEEK_START + 1 * DAY + 13 * 3_600_000);
    const from = WEEK_START + 160 * 7 * DAY;
    expect((await schedule(from, from + 7 * DAY)).body.data).toEqual([]);
  });

  it('shows the past from what the source recorded, and fills the weeks since the newest record', async () => {
    const show = await newTitle('Recorded');
    await add(show);
    await airs(show, 4, WEEK_START - 20 * DAY);
    await airs(show, 5, WEEK_START - 13 * DAY);
    const response = await schedule(WEEK_START - 28 * DAY, WEEK_START);
    expect(response.body.data.map((slot: Slot) => [slot.episode, slot.projected])).toEqual([
      [4, false],
      [5, false],
      // The week after the newest record has passed too: carried forward, still marked as not announced.
      [6, true],
    ]);
    // Nothing is invented before the first record.
    const before = await schedule(WEEK_START - 42 * DAY, WEEK_START - 28 * DAY);
    expect(before.body.data).toEqual([]);
  });

  it('does not project a show that has finished or whose run went quiet', async () => {
    const finished = await newTitle('Finished', { status: 'finished' });
    const stale = await newTitle('Gone quiet');
    await add(finished);
    await add(stale);
    await airs(finished, 12, WEEK_START - 2 * DAY);
    await airs(stale, 4, NOW - 40 * DAY);
    const response = await schedule(WEEK_START + 7 * DAY, WEEK_START + 14 * DAY);
    expect(response.body.data).toEqual([]);
  });

  it('is private: another user sees none of it', async () => {
    const show = await newTitle('Mine');
    await add(show);
    await airs(show, 8, WEEK_START + DAY);
    const other = await t.signIn('other');
    expect((await schedule(WEEK_START, WEEK_START + 7 * DAY, other.auth)).body.data).toEqual([]);
    expect((await schedule(WEEK_START, WEEK_START + 7 * DAY)).body.data).toHaveLength(1);
  });

  it('refuses a missing, backwards or too long window, and anonymous callers', async () => {
    expect((await t.get('/library/schedule', auth)).status).toBe(422);
    expect((await schedule(WEEK_START + DAY, WEEK_START)).status).toBe(422);
    expect((await schedule(WEEK_START, WEEK_START + 44 * DAY)).status).toBe(422);
    expect((await request(t.app).get('/v1/library/schedule')).status).toBe(401);
  });
});
