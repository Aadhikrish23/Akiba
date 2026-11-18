import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, problem, renderApp, signedInHandler, violations, type Call } from './test/render';

/**
 * T24: the Inbox page and the unread badge, with the real API client over a fake network.
 * Requirement IDs: FR-NOTE-003 (list, mark read, mark all read, delete, unread count),
 * FR-NOTE-004 (alerts can be turned off), FR-NOTE-005 (nothing is pushed or emailed).
 */

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const card = (n: number) => ({
  id: id(n),
  kind: 'tv',
  titleRomaji: `Show ${n}`,
  titleEnglish: null,
  titleNative: null,
  coverUrl: n === 1 ? null : `https://img.example.test/${n}.jpg`,
  format: 'TV',
  status: 'releasing',
  episodesTotal: 12,
  season: 'fall',
  seasonYear: 2026,
  averageScore: 80,
  libraryStatus: 'watching',
  libraryEntryId: id(500 + n),
});

const note = (n: number, extra: { readAt?: string | null } = {}) => ({
  id: id(100 + n),
  kind: 'episode_aired',
  createdAt: `2026-11-20T15:0${n}:00.000Z`,
  readAt: null as string | null,
  episode: { number: n + 6, airsAt: '2026-11-20T14:00:00.000Z' },
  title: card(n),
  ...extra,
});

interface Store {
  items: ReturnType<typeof note>[];
}

/** A server whose inbox is `store`, behaving like the real one. */
function inboxServer(
  store: Store,
  extra: (call: Call) => Response | undefined = () => undefined,
  me = {},
) {
  return signedInHandler(me, (call) => {
    const override = extra(call);
    if (override !== undefined) return override;
    const unread = () => store.items.filter((item) => item.readAt === null).length;
    if (call.method === 'GET' && call.path.endsWith('/inbox/unread-count'))
      return json(200, { data: { count: unread() } });
    if (call.method === 'GET' && call.path.endsWith('/inbox')) {
      const onlyUnread = new URLSearchParams(call.search).get('unread') === 'true';
      const data = store.items.filter((item) => !onlyUnread || item.readAt === null);
      return json(200, { data, nextCursor: null });
    }
    if (call.method === 'POST' && call.path.endsWith('/inbox/read-all')) {
      const updated = unread();
      store.items = store.items.map((item) => ({ ...item, readAt: item.readAt ?? 'now' }));
      return json(200, { data: { updated } });
    }
    if (call.method === 'POST' && call.path.endsWith('/read')) {
      const found = store.items.find((item) => call.path.includes(item.id));
      if (found === undefined) return problem(404, 'NOT_FOUND');
      found.readAt = found.readAt ?? '2026-11-20T16:00:00.000Z';
      return json(200, { data: found });
    }
    if (call.method === 'DELETE') {
      store.items = store.items.filter((item) => !call.path.includes(item.id));
      return new Response(null, { status: 204 });
    }
    return problem(404, 'NOT_FOUND');
  });
}

const nav = () => screen.getByRole('navigation', { name: 'Main' });

describe('The unread badge (FR-NOTE-003)', () => {
  it('shows the count on the Inbox link, spoken as "unread", and nothing at zero', async () => {
    const store: Store = { items: [note(1), note(2), note(3)] };
    renderApp({ route: '/', handler: inboxServer(store) });
    const link = await within(await waitForNav()).findByRole('link', { name: 'Inbox 3 unread' });
    expect(link.getAttribute('href')).toBe('/inbox');
    store.items = [];
    await act(async () => {
      window.dispatchEvent(new Event('focus')); // coming back to the tab asks again
      await Promise.resolve();
    });
    expect(await within(nav()).findByRole('link', { name: 'Inbox' })).toBeTruthy();
  });

  it('caps the number at 99+', async () => {
    renderApp({
      route: '/',
      handler: inboxServer({ items: [] }, (call) =>
        call.path.endsWith('/inbox/unread-count') ? json(200, { data: { count: 150 } }) : undefined,
      ),
    });
    expect(
      await within(await waitForNav()).findByRole('link', { name: 'Inbox 99+ unread' }),
    ).toBeTruthy();
  });

  it('keeps the last number when the server cannot be reached', async () => {
    let fail = false;
    const store: Store = { items: [note(1)] };
    renderApp({
      route: '/',
      handler: inboxServer(store, (call) =>
        fail && call.path.endsWith('/inbox/unread-count') ? problem(503, 'DOWN') : undefined,
      ),
    });
    await within(await waitForNav()).findByRole('link', { name: 'Inbox 1 unread' });
    fail = true;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    expect(within(nav()).getByRole('link', { name: 'Inbox 1 unread' })).toBeTruthy();
  });
});

async function waitForNav() {
  await screen.findByRole('navigation', { name: 'Main' });
  return nav();
}

describe('Inbox page (FR-NOTE-003)', () => {
  it('lists each aired episode with its title, the time in the reader’s zone, and a New marker', async () => {
    const store: Store = { items: [note(1), note(2, { readAt: '2026-11-20T15:30:00.000Z' })] };
    renderApp({
      route: '/inbox',
      handler: inboxServer(store, undefined, { timeZone: 'Asia/Tokyo' }),
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Inbox' })).toBeTruthy();
    const list = await screen.findByRole('list', { name: 'Notifications' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByRole('link', { name: 'Show 1' }).getAttribute('href')).toBe(
      `/title/${id(1)}`,
    );
    expect(within(rows[0]!).getByText('New')).toBeTruthy();
    expect(within(rows[1]!).queryByText('New')).toBeNull(); // read
    expect(within(rows[0]!).getByText(/Episode 7 aired/)).toBeTruthy();
    // 14:00 UTC is 23:00 in Tokyo, and the zone is named, in whichever format the locale uses.
    const time = rows[0]!.querySelector('time')!;
    expect(time.getAttribute('datetime')).toBe('2026-11-20T14:00:00.000Z');
    expect(time.textContent).toMatch(/11:00\s?PM|23:00/i);
    expect(time.textContent).toMatch(/GMT\+9|JST/);
  });

  it('marks one as read at once, updates the badge, and tells a screen reader', async () => {
    const store: Store = { items: [note(1), note(2)] };
    const app = renderApp({ route: '/inbox', handler: inboxServer(store) });
    await within(await waitForNav()).findByRole('link', { name: 'Inbox 2 unread' });
    const button = await screen.findByRole('button', { name: 'Mark as read: episode 7 of Show 1' });
    await app.user.click(button);
    expect(within(nav()).getByRole('link', { name: 'Inbox 1 unread' })).toBeTruthy();
    expect(screen.getByText('Marked episode 7 of Show 1 as read.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Mark as read: episode 7 of Show 1' })).toBeNull();
    await waitFor(() => {
      expect(
        app.calls.some((call) => call.method === 'POST' && call.path.endsWith(`/${id(101)}/read`)),
      ).toBe(true);
    });
  });

  it('puts it back and says so when the server refuses', async () => {
    const store: Store = { items: [note(1)] };
    const app = renderApp({
      route: '/inbox',
      handler: inboxServer(store, (call) =>
        call.method === 'POST' && call.path.endsWith('/read') ? problem(500, 'BOOM') : undefined,
      ),
    });
    await app.user.click(
      await screen.findByRole('button', { name: 'Mark as read: episode 7 of Show 1' }),
    );
    expect((await screen.findByRole('alert')).textContent).toMatch(/It was not marked as read/);
    expect(
      await screen.findByRole('button', { name: 'Mark as read: episode 7 of Show 1' }),
    ).toBeTruthy();
  });

  it('marks everything as read', async () => {
    const store: Store = { items: [note(1), note(2), note(3)] };
    const app = renderApp({ route: '/inbox', handler: inboxServer(store) });
    await within(await waitForNav()).findByRole('link', { name: 'Inbox 3 unread' });
    await app.user.click(screen.getByRole('button', { name: 'Mark all as read' }));
    expect(await screen.findByText('Marked 3 as read.')).toBeTruthy();
    expect(within(nav()).getByRole('link', { name: 'Inbox' })).toBeTruthy();
    expect(screen.queryByText('New')).toBeNull();
    expect(screen.getByText('Nothing unread.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Mark all as read' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('deletes one, and puts it back with a message when the server refuses', async () => {
    const store: Store = { items: [note(1), note(2)] };
    let refuse = false;
    const app = renderApp({
      route: '/inbox',
      handler: inboxServer(store, (call) =>
        refuse && call.method === 'DELETE' ? problem(500, 'BOOM') : undefined,
      ),
    });
    await within(await waitForNav()).findByRole('link', { name: 'Inbox 2 unread' });
    await app.user.click(
      await screen.findByRole('button', { name: 'Delete: episode 7 of Show 1' }),
    );
    expect(screen.getByText('Deleted episode 7 of Show 1.')).toBeTruthy();
    expect(
      within(await screen.findByRole('list', { name: 'Notifications' })).getAllByRole('listitem'),
    ).toHaveLength(1);
    expect(within(nav()).getByRole('link', { name: 'Inbox 1 unread' })).toBeTruthy();

    refuse = true;
    await app.user.click(screen.getByRole('button', { name: 'Delete: episode 8 of Show 2' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/It was not deleted/);
    expect(await screen.findByRole('button', { name: 'Delete: episode 8 of Show 2' })).toBeTruthy();
  });

  it('"Unread only" asks the server for unread items and says when all are read', async () => {
    const store: Store = { items: [note(1, { readAt: '2026-11-20T15:30:00.000Z' })] };
    const app = renderApp({ route: '/inbox', handler: inboxServer(store) });
    await screen.findByRole('list', { name: 'Notifications' });
    await app.user.selectOptions(screen.getByLabelText('Show'), 'Unread only');
    expect(await screen.findByText('You are all caught up.')).toBeTruthy();
    await waitFor(() => {
      expect(
        app.to('/inbox').some((call) => new URLSearchParams(call.search).get('unread') === 'true'),
      ).toBe(true);
    });
  });

  it('opening a title marks it read, quietly', async () => {
    const store: Store = { items: [note(1)] };
    const app = renderApp({ route: '/inbox', handler: inboxServer(store) });
    await app.user.click(await screen.findByRole('link', { name: 'Show 1' }));
    await waitFor(() => {
      expect(app.calls.some((call) => call.method === 'POST' && call.path.endsWith('/read'))).toBe(
        true,
      );
    });
  });

  it('pages with Load more', async () => {
    const pages = [
      { data: [note(1), note(2)], nextCursor: 'next' },
      { data: [note(3)], nextCursor: null },
    ];
    const app = renderApp({
      route: '/inbox',
      handler: signedInHandler({}, (call) => {
        if (call.path.endsWith('/unread-count')) return json(200, { data: { count: 3 } });
        if (call.path.endsWith('/inbox')) {
          return json(
            200,
            new URLSearchParams(call.search).get('cursor') === 'next' ? pages[1] : pages[0],
          );
        }
        return problem(404, 'NOT_FOUND');
      }),
    });
    await screen.findByRole('list', { name: 'Notifications' });
    await app.user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => {
      expect(
        within(screen.getByRole('list', { name: 'Notifications' })).getAllByRole('listitem'),
      ).toHaveLength(3);
    });
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('empty: says what will appear, and points to Settings when alerts are off', async () => {
    renderApp({
      route: '/inbox',
      handler: inboxServer({ items: [] }, undefined, { alertsEnabled: false }),
    });
    expect(await screen.findByText(/When a new episode of a title you are/)).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Turn them on in Settings' }).getAttribute('href'),
    ).toBe('/settings');
  });

  it('an error offers Try again', async () => {
    let attempts = 0;
    const app = renderApp({
      route: '/inbox',
      strict: false,
      handler: inboxServer({ items: [note(1)] }, (call) => {
        if (call.method === 'GET' && call.path.endsWith('/inbox')) {
          attempts += 1;
          if (attempts === 1) return problem(403, 'FORBIDDEN');
        }
        return undefined;
      }),
    });
    expect((await screen.findByRole('alert')).textContent).toMatch(/\S/);
    await app.user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('list', { name: 'Notifications' })).toBeTruthy();
  });

  it('is free of automatically detectable accessibility problems', async () => {
    const app = renderApp({
      route: '/inbox',
      handler: inboxServer({ items: [note(1), note(2, { readAt: '2026-11-20T15:30:00.000Z' })] }),
    });
    await screen.findByRole('list', { name: 'Notifications' });
    await within(await waitForNav()).findByRole('link', { name: 'Inbox 1 unread' });
    expect(await violations(app.container)).toEqual([]);
  });
});
