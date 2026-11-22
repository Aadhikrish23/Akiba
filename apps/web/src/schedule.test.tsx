import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { json, renderApp, signedInHandler, violations, type Call } from './test/render';

/** The Schedule screen: tonight, the week as a timetable in broadcast time, and +1 from a slot. */

const ENTRY = '11111111-1111-4111-8111-111111111111';
const TITLE = '00000000-0000-4000-8000-000000000001';

const card = {
  id: TITLE,
  kind: 'tv',
  titleRomaji: 'Show 1',
  titleEnglish: null,
  titleNative: null,
  coverUrl: null,
  coverColor: '#e4a128',
  format: 'TV',
  status: 'releasing',
  episodesTotal: 12,
  season: 'fall',
  seasonYear: 2026,
  averageScore: null,
  libraryStatus: 'watching',
  libraryEntryId: ENTRY,
};

const detail = (progress: number) => ({
  id: ENTRY,
  title: card,
  status: 'watching',
  progress,
  effectiveTotal: 12,
  totalOverridden: false,
  rating: null,
  isFavorite: false,
  alertsEnabled: null,
  startedAt: '2026-11-01T00:00:00.000Z',
  completedAt: null,
  addedAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-02T00:00:00.000Z',
  review: null,
  notes: null,
  runs: [],
});

/**
 * The clock is pinned to the middle of a week (Wednesday noon, UTC), so what is "this week" and
 * what has aired never depends on the day the suite runs. Only Date is faked: timers stay real.
 */
const NOW = '2026-11-25T12:00:00.000Z';
const AIRED = '2026-11-25T11:00:00.000Z';

const slot = (extra: Record<string, unknown> = {}) => ({
  entryId: ENTRY,
  title: card,
  entryStatus: 'watching',
  episode: 8,
  airsAt: AIRED,
  projected: false,
  progress: 7,
  watched: false,
  ...extra,
});

const serving = (slots: unknown[], onProgress?: (call: Call) => Response) =>
  signedInHandler({ timeZone: 'UTC' }, (call) => {
    if (call.path.endsWith('/library/schedule')) return json(200, { data: slots });
    if (call.path.endsWith('/progress') && onProgress !== undefined) return onProgress(call);
    return json(404, {});
  });

describe('Schedule', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the week, asks the server for it in the account time zone, and counts what is waiting', async () => {
    const app = renderApp({ route: '/schedule', handler: serving([slot()]) });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Your week, on air.' }),
    ).toBeTruthy();
    expect(await screen.findByText(/1 episode has aired and is waiting for a stamp/)).toBeTruthy();
    const request = app.to('/library/schedule')[0];
    const query = new URLSearchParams(request?.search);
    expect(Date.parse(query.get('to') ?? '') - Date.parse(query.get('from') ?? '')).toBe(
      (7 * 24 + 6) * 3_600_000,
    );
    expect(screen.getByRole('table', { name: /Weekly airing schedule/ })).toBeTruthy();
  });

  it('+1 on an aired slot logs the next episode and the slot turns to watched', async () => {
    const app = renderApp({
      route: '/schedule',
      handler: serving([slot()], () => json(200, { data: detail(8), suggestComplete: false })),
    });
    const [button] = await screen.findAllByRole('button', { name: '+1 episode of Show 1' });
    await app.user.click(button!);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '+1 episode of Show 1' })).toBeNull();
    });
    expect(app.to('/progress')[0]?.body).toEqual({ delta: 1 });
    expect(screen.getAllByRole('group', { name: /episode 8, .*watched$/ }).length).toBeGreaterThan(
      0,
    );
  });

  it('puts a failed +1 back and says why', async () => {
    const app = renderApp({
      route: '/schedule',
      handler: serving([slot()], () => json(500, { code: 'INTERNAL', detail: 'no' })),
    });
    const [button] = await screen.findAllByRole('button', { name: '+1 episode of Show 1' });
    await app.user.click(button!);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '+1 episode of Show 1' }).length).toBeGreaterThan(
      0,
    );
  });

  it('marks a weekly slot the source has not announced as expected', async () => {
    renderApp({
      route: '/schedule',
      handler: serving([
        slot({ projected: true, airsAt: new Date(Date.now() + 86_400_000).toISOString() }),
      ]),
    });
    const groups = await screen.findAllByRole('group', {
      name: /episode 8, .*\(expected\), not yet aired/,
    });
    expect(groups.length).toBeGreaterThan(0);
  });

  it('says so when nothing airs, and offers a way to find something', async () => {
    renderApp({ route: '/schedule', handler: serving([]) });
    expect(await screen.findAllByText(/Nothing from your list airs this week/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Find something to watch' })).toBeTruthy();
  });

  it('steps to the next week and back', async () => {
    const app = renderApp({ route: '/schedule', handler: serving([]) });
    await screen.findByRole('button', { name: 'Next week' });
    await waitFor(() => {
      expect(app.to('/library/schedule').length).toBeGreaterThan(0);
    });
    const first = app.to('/library/schedule').length;
    await app.user.click(screen.getByRole('button', { name: 'Next week' }));
    await waitFor(() => {
      expect(app.to('/library/schedule')).toHaveLength(first + 1);
    });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Next week' }).disabled).toBe(
      true,
    );
    await app.user.click(screen.getByRole('button', { name: 'This week' }));
    await waitFor(() => {
      expect(app.to('/library/schedule')).toHaveLength(first + 2);
    });
  });

  it('shows the error and a retry when the week cannot load', async () => {
    const app = renderApp({
      route: '/schedule',
      handler: signedInHandler({}, () => json(500, { code: 'INTERNAL', detail: 'down' })),
    });
    expect(await screen.findByRole('alert')).toBeTruthy();
    await app.user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(app.to('/library/schedule').length).toBeGreaterThan(1);
    });
  });

  it('has no axe violations (WCAG 2.2 AA)', async () => {
    const app = renderApp({ route: '/schedule', handler: serving([slot()]) });
    await screen.findByRole('table', { name: /Weekly airing schedule/ });
    expect(await violations(app.container)).toEqual([]);
  });

  it('Home shows the week strip with the same slots', async () => {
    renderApp({
      route: '/',
      handler: signedInHandler({ timeZone: 'UTC' }, (call) => {
        if (call.path.endsWith('/library/schedule')) return json(200, { data: [slot()] });
        if (call.path.endsWith('/library')) return json(200, { data: [], nextCursor: null });
        return json(404, {});
      }),
    });
    const strip = await screen.findByRole('group', { name: 'Episodes this week' });
    expect(within(strip).getAllByRole('group', { name: /Show 1, episode 8/ }).length).toBe(1);
    expect(screen.getByRole('link', { name: 'Full schedule' })).toBeTruthy();
  });
});
