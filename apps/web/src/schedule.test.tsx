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
    try {
      localStorage.clear();
    } catch {
      // no storage: the default view is the week
    }
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

  const fromOf = (call: Call | undefined) =>
    new URLSearchParams(call?.search).get('from')?.slice(0, 10);
  const lastFrom = (app: { to: (suffix: string) => Call[] }) =>
    fromOf(app.to('/library/schedule').at(-1));

  it('steps through weeks without a limit, and back to this one', async () => {
    const app = renderApp({ route: '/schedule', handler: serving([]) });
    await screen.findByRole('button', { name: 'Next week' });
    await waitFor(() => {
      expect(lastFrom(app)).toBe('2026-11-23');
    });
    for (let i = 0; i < 10; i += 1) {
      await app.user.click(screen.getByRole('button', { name: 'Next week' }));
    }
    // Ten weeks on is the week of 1 February: nothing stops you, and nothing is greyed out.
    await waitFor(() => {
      expect(lastFrom(app)).toBe('2027-02-01');
    });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Next week' }).disabled).toBe(
      false,
    );
    expect(screen.getByText('Feb 1 – 7, 2027')).toBeTruthy();
    for (let i = 0; i < 3; i += 1) {
      await app.user.click(screen.getByRole('button', { name: 'Previous week' }));
    }
    await waitFor(() => {
      expect(lastFrom(app)).toBe('2027-01-11');
    });
    await app.user.click(screen.getByRole('button', { name: 'This week' }));
    await waitFor(() => {
      expect(lastFrom(app)).toBe('2026-11-23');
    });
  });

  describe('the month view', () => {
    const toMonth = async (app: ReturnType<typeof renderApp>) => {
      await app.user.click(await screen.findByRole('radio', { name: 'month' }));
    };

    it('asks for the six-week grid in one request, and remembers the choice', async () => {
      const app = renderApp({ route: '/schedule', handler: serving([slot()]) });
      await toMonth(app);
      expect(
        await screen.findByRole('table', { name: /November 2026: episodes airing/ }),
      ).toBeTruthy();
      const calls = app.to('/library/schedule');
      const query = new URLSearchParams(calls.at(-1)?.search);
      // November 2026 starts on a Sunday: the grid runs Mon 26 Oct to Sun 6 Dec, plus the small hours.
      expect(query.get('from')?.slice(0, 10)).toBe('2026-10-26');
      expect(Date.parse(query.get('to') ?? '') - Date.parse(query.get('from') ?? '')).toBe(
        (42 * 24 + 6) * 3_600_000,
      );
      expect(localStorage.getItem('akiba.schedule.mode')).toBe('month');
    });

    it('opens in the month when that is what was chosen last time', async () => {
      localStorage.setItem('akiba.schedule.mode', 'month');
      renderApp({ route: '/schedule', handler: serving([slot()]) });
      expect(
        await screen.findByRole('table', { name: /November 2026: episodes airing/ }),
      ).toBeTruthy();
    });

    it('shows the chosen day beside the grid, and +1 works from there', async () => {
      const app = renderApp({
        route: '/schedule',
        handler: serving([slot()], () => json(200, { data: detail(8), suggestComplete: false })),
      });
      await toMonth(app);
      // Today is selected: the panel lists what airs, the grid cell says what is in it.
      const panel = await screen.findByRole('complementary');
      expect(within(panel).getByRole('heading', { name: 'WED 25 Nov' })).toBeTruthy();
      expect(
        screen.getByRole('button', { name: 'WED 25 November, 1 episode, waiting for a stamp' }),
      ).toBeTruthy();
      await app.user.click(within(panel).getByRole('button', { name: '+1 episode of Show 1' }));
      await waitFor(() => {
        expect(app.to('/progress')).toHaveLength(1);
      });
      expect(within(panel).getAllByRole('group', { name: /episode 8, .*watched$/ })).toHaveLength(
        1,
      );
    });

    it('picking another day shows that day, and an empty one says so', async () => {
      const app = renderApp({ route: '/schedule', handler: serving([slot()]) });
      await toMonth(app);
      await app.user.click(
        await screen.findByRole('button', { name: 'FRI 27 November, nothing airing' }),
      );
      const panel = screen.getByRole('complementary');
      expect(within(panel).getByRole('heading', { name: 'FRI 27 Nov' })).toBeTruthy();
      expect(within(panel).getByText('Nothing from your list airs on this day.')).toBeTruthy();
      expect(within(panel).getByText(/In 2 days/)).toBeTruthy();
    });

    it('picking a day of the neighbouring month opens that month on that day', async () => {
      const app = renderApp({ route: '/schedule', handler: serving([]) });
      await toMonth(app);
      await app.user.click(
        await screen.findByRole('button', { name: 'MON 26 October, nothing airing' }),
      );
      expect(await screen.findByText('October 2026')).toBeTruthy();
      const panel = await screen.findByRole('complementary');
      expect(within(panel).getByRole('heading', { name: 'MON 26 Oct' })).toBeTruthy();
    });

    it('steps by month and jumps to any month and year', async () => {
      const app = renderApp({ route: '/schedule', handler: serving([]) });
      await toMonth(app);
      await app.user.click(await screen.findByRole('button', { name: 'Next month' }));
      expect(await screen.findByText('December 2026')).toBeTruthy();
      await waitFor(() => {
        // December 2026 starts on a Tuesday: the grid begins on Monday 30 November.
        expect(lastFrom(app)).toBe('2026-11-30');
      });

      await app.user.selectOptions(screen.getByRole('combobox', { name: 'Year' }), '2028');
      await app.user.selectOptions(screen.getByRole('combobox', { name: 'Month' }), 'February');
      expect(await screen.findByText('February 2028')).toBeTruthy();
      await waitFor(() => {
        expect(lastFrom(app)).toBe('2028-01-31');
      });

      await app.user.click(screen.getByRole('button', { name: 'This month' }));
      expect(await screen.findByText('November 2026')).toBeTruthy();
    });

    it('keys step and switch views when no field has focus', async () => {
      const app = renderApp({ route: '/schedule', handler: serving([]) });
      await screen.findByRole('button', { name: 'Next week' });
      await app.user.keyboard('{ArrowRight}');
      await waitFor(() => {
        expect(lastFrom(app)).toBe('2026-11-30');
      });
      await app.user.keyboard('m');
      expect(await screen.findByRole('table', { name: /December 2026/ })).toBeTruthy();
      await app.user.keyboard('t');
      expect(await screen.findByRole('table', { name: /November 2026/ })).toBeTruthy();
      await app.user.keyboard('w');
      expect(await screen.findByRole('button', { name: 'Next week' })).toBeTruthy();
    });

    it('has no axe violations (WCAG 2.2 AA)', async () => {
      const app = renderApp({ route: '/schedule', handler: serving([slot()]) });
      await toMonth(app);
      await screen.findByRole('table', { name: /November 2026: episodes airing/ });
      expect(await violations(app.container)).toEqual([]);
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
