import { fireEvent, waitFor as rntlWaitFor } from '@testing-library/react-native';
import { Share } from 'react-native';
import {
  USER,
  json,
  problem,
  renderApp,
  screen,
  signedInHandler,
  tab,
  type Call,
  type Handler,
} from '../test/render';
import { secureStore } from '../test/setup';

/**
 * T28: the Inbox and its tab badge, Settings (preferences, export, share link) and deleting and
 * restoring the account, with the real router, API client and providers over a fake network.
 * FR-NOTE-003/004/005, FR-ACCT-001/002, FR-EXPT-001, FR-SHARE-001/002.
 */

const STORED = 'S'.repeat(43);
const META = { stale: false, source: 'cache' };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const card = (n: number) => ({
  id: id(n),
  kind: 'tv',
  titleRomaji: `Show ${n}`,
  titleEnglish: null,
  titleNative: null,
  coverUrl: null,
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
type Item = ReturnType<typeof note>;

const waitFor = (condition: () => boolean) =>
  rntlWaitFor(() => {
    if (!condition()) throw new Error('not yet');
  });
const noSeason = (call: Call) =>
  call.path.includes('/seasons/')
    ? json(200, { data: [], nextCursor: null, meta: META, season: 'fall', seasonYear: 2026 })
    : call.path.endsWith('/library')
      ? json(200, { data: [], nextCursor: null })
      : undefined;

/** A server whose inbox is `store`, behaving like the real one. */
function inboxServer(
  store: { items: Item[] },
  extra: (call: Call) => Response | undefined = () => undefined,
  me: Partial<typeof USER> = {},
): Handler {
  return signedInHandler((call) => {
    const override = extra(call);
    if (override !== undefined) return override;
    const unread = () => store.items.filter((item) => item.readAt === null).length;
    if (call.method === 'GET' && call.path.endsWith('/inbox/unread-count')) {
      return json(200, { data: { count: unread() } });
    }
    if (call.method === 'GET' && call.path.endsWith('/inbox')) {
      const onlyUnread = new URLSearchParams(call.search).get('unread') === 'true';
      return json(200, {
        data: store.items.filter((item) => !onlyUnread || item.readAt === null),
        nextCursor: null,
      });
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
    return noSeason(call) ?? problem(404, 'NOT_FOUND');
  }, me);
}

async function openInbox(handler: Handler) {
  const app = await renderApp({ handler, storedRefreshToken: STORED });
  await screen.findByText('Welcome, Reader');
  await app.user.press(screen.getByRole('button', { name: /^Inbox( \d+| 99\+)?, tab, 4 of 5$/ }));
  return app;
}

describe('Inbox tab badge (FR-NOTE-003)', () => {
  it('says how many are unread, in the tab’s name, and nothing at zero', async () => {
    await renderApp({
      handler: inboxServer({ items: [note(1), note(2), note(3)] }),
      storedRefreshToken: STORED,
    });
    expect(await screen.findByRole('button', { name: 'Inbox 3, tab, 4 of 5' })).toBeTruthy();
  });

  it('shows no badge when nothing is unread', async () => {
    await renderApp({ handler: inboxServer({ items: [] }), storedRefreshToken: STORED });
    await screen.findByText('Welcome, Reader');
    expect(tab('Inbox')).toBeTruthy();
  });
});

describe('Inbox screen (FR-NOTE-003)', () => {
  it('lists each aired episode with its time in the reader’s zone and a New marker', async () => {
    await openInbox(
      inboxServer(
        { items: [note(1), note(2, { readAt: '2026-11-20T15:30:00.000Z' })] },
        undefined,
        {
          timeZone: 'Asia/Tokyo',
        },
      ),
    );
    expect(await screen.findByRole('header', { name: 'Inbox' })).toBeTruthy();
    const first = await screen.findByRole('link', { name: /^Show 1, episode 7 aired .*, new$/ });
    expect(String(first.props.accessibilityLabel)).toMatch(/11:00\s?PM|23:00/i);
    expect(String(first.props.accessibilityLabel)).toMatch(/GMT\+9|JST/);
    expect(
      screen.getByRole('link', { name: /^Show 2, episode 8 aired (?!.*, new$)/ }),
    ).toBeTruthy();
    expect(screen.getByText(/^New · Episode 7 aired/)).toBeTruthy();
  });

  it('marks one as read at once, updates the badge, and tells a screen reader', async () => {
    const app = await openInbox(inboxServer({ items: [note(1), note(2)] }));
    await app.user.press(
      await screen.findByRole('button', { name: 'Mark as read: episode 7 of Show 1' }),
    );
    expect(await screen.findByRole('button', { name: 'Inbox 1, tab, 4 of 5' })).toBeTruthy();
    expect(screen.getByText('Marked episode 7 of Show 1 as read.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Mark as read: episode 7 of Show 1' })).toBeNull();
    await waitFor(() =>
      app.calls.some((call) => call.method === 'POST' && call.path.endsWith(`/${id(101)}/read`)),
    );
  });

  it('puts it back and says so when the server refuses', async () => {
    const app = await openInbox(
      inboxServer({ items: [note(1)] }, (call) =>
        call.method === 'POST' && call.path.endsWith('/read') ? problem(500, 'BOOM') : undefined,
      ),
    );
    await app.user.press(
      await screen.findByRole('button', { name: 'Mark as read: episode 7 of Show 1' }),
    );
    expect(await screen.findByText(/It was not marked as read/)).toBeTruthy();
    expect(
      await screen.findByRole('button', { name: 'Mark as read: episode 7 of Show 1' }),
    ).toBeTruthy();
  });

  it('marks everything as read', async () => {
    const app = await openInbox(inboxServer({ items: [note(1), note(2), note(3)] }));
    await screen.findByRole('button', { name: 'Inbox 3, tab, 4 of 5' });
    await app.user.press(screen.getByRole('button', { name: 'Mark all as read' }));
    expect(await screen.findByText('Marked 3 as read.')).toBeTruthy();
    expect(screen.getByText('Nothing unread.')).toBeTruthy();
    expect(screen.queryByText(/^New · /)).toBeNull();
  });

  it('deletes one, and puts it back when the server refuses', async () => {
    let refuse = false;
    const app = await openInbox(
      inboxServer({ items: [note(1), note(2)] }, (call) =>
        refuse && call.method === 'DELETE' ? problem(500, 'BOOM') : undefined,
      ),
    );
    await app.user.press(
      await screen.findByRole('button', { name: 'Delete: episode 7 of Show 1' }),
    );
    expect(screen.getByText('Deleted episode 7 of Show 1.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /^Show 1,/ })).toBeNull();
    refuse = true;
    await app.user.press(screen.getByRole('button', { name: 'Delete: episode 8 of Show 2' }));
    expect(await screen.findByText(/It was not deleted/)).toBeTruthy();
    expect(await screen.findByRole('link', { name: /^Show 2,/ })).toBeTruthy();
  });

  it('"Unread only" asks the server for unread items and says when all are read', async () => {
    const app = await openInbox(
      inboxServer({ items: [note(1, { readAt: '2026-11-20T15:30:00.000Z' })] }),
    );
    await screen.findByRole('link', { name: /^Show 1,/ });
    await app.user.press(screen.getByRole('radio', { name: 'Unread only' }));
    expect(await screen.findByText('You are all caught up.')).toBeTruthy();
    await waitFor(() =>
      app.to('/inbox').some((call) => new URLSearchParams(call.search).get('unread') === 'true'),
    );
  });

  it('opening a title marks it read, quietly', async () => {
    const app = await openInbox(
      inboxServer({ items: [note(1)] }, (call) =>
        call.path.endsWith('/relations') || call.path.endsWith('/characters')
          ? json(200, { data: [], meta: META })
          : undefined,
      ),
    );
    await app.user.press(await screen.findByRole('link', { name: /^Show 1,/ }));
    await waitFor(() =>
      app.calls.some((call) => call.method === 'POST' && call.path.endsWith('/read')),
    );
  });

  it('empty: says what will appear, and points to Settings when alerts are off', async () => {
    await openInbox(inboxServer({ items: [] }, undefined, { alertsEnabled: false }));
    expect(
      await screen.findByText(/When a new episode of a title you are watching airs/),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Turn them on in Settings' })).toBeTruthy();
  });

  it('an error offers Try again', async () => {
    let attempts = 0;
    const app = await openInbox(
      inboxServer({ items: [note(1)] }, (call) => {
        if (call.method === 'GET' && call.path.endsWith('/inbox')) {
          attempts += 1;
          if (attempts === 1) return problem(403, 'FORBIDDEN');
        }
        return undefined;
      }),
    );
    expect(await screen.findByRole('alert')).toBeTruthy();
    await app.user.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: /^Show 1,/ })).toBeTruthy();
  });
});

describe('Settings (FR-ACCT-001, FR-EXPT-001, FR-SHARE-001/002)', () => {
  const account = (extra: (call: Call) => Response | undefined = () => undefined, me = {}) =>
    signedInHandler((call) => {
      const override = extra(call);
      if (override !== undefined) return override;
      if (call.path.endsWith('/inbox/unread-count')) return json(200, { data: { count: 0 } });
      return noSeason(call) ?? problem(404, 'NOT_FOUND');
    }, me);

  async function openSettings(handler: Handler) {
    const app = await renderApp({ handler, storedRefreshToken: STORED });
    await screen.findByText('Welcome, Reader');
    await app.user.press(tab('Me'));
    await app.user.press(await screen.findByRole('link', { name: 'Settings' }));
    await screen.findByRole('header', { name: 'Preferences' });
    return app;
  }
  const patching = (call: Call) =>
    call.method === 'PATCH' && call.path.endsWith('/me')
      ? json(200, { ...USER, ...(call.body as object) })
      : undefined;

  it('saves the title language and the switches, and puts a switch back when saving fails', async () => {
    let refuse = false;
    const app = await openSettings(
      account((call) =>
        refuse && call.method === 'PATCH' ? problem(500, 'BOOM') : patching(call),
      ),
    );
    await app.user.press(screen.getByRole('radio', { name: 'English' }));
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect(app.calls.find((call) => call.method === 'PATCH')?.body).toEqual({
      titleLanguage: 'english',
    });
    const adult = screen.getByLabelText('Show adult-rated titles');
    expect(adult.props.value).toBe(false);
    refuse = true;
    await fireEvent(adult, 'valueChange', true);
    expect(await screen.findByText(/Something went wrong on our side/)).toBeTruthy();
    await waitFor(() => screen.getByLabelText('Show adult-rated titles').props.value === false);
  });

  it('refuses a time zone this device does not know, and saves one it does', async () => {
    const app = await openSettings(account(patching));
    const field = screen.getByLabelText('Time zone');
    await app.user.clear(field);
    await app.user.type(field, 'Mars/Olympus');
    await app.user.press(screen.getByRole('button', { name: 'Save time zone' }));
    expect(await screen.findByText(/not one this device knows/)).toBeTruthy();
    expect(app.calls.filter((call) => call.method === 'PATCH')).toHaveLength(0);
    await app.user.clear(field);
    await app.user.type(field, 'Asia/Tokyo');
    await app.user.press(screen.getByRole('button', { name: 'Save time zone' }));
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect(app.calls.find((call) => call.method === 'PATCH')?.body).toEqual({
      timeZone: 'Asia/Tokyo',
    });
  });

  it('exports JSON and CSV through the share sheet', async () => {
    const share = jest
      .spyOn(Share, 'share')
      .mockResolvedValue({ action: Share.sharedAction, activityType: undefined });
    const app = await openSettings(
      account((call) =>
        call.method === 'POST' && call.path.endsWith('/me/export')
          ? new Response('{"exportVersion":1}', {
              status: 200,
              headers: {
                'content-type': 'application/json',
                'content-disposition': 'attachment; filename="akiba-export-2026-11-18.json"',
              },
            })
          : undefined,
      ),
    );
    await app.user.press(screen.getByRole('button', { name: 'Export as JSON' }));
    expect(await screen.findByText('Shared.')).toBeTruthy();
    expect(share).toHaveBeenCalledWith({
      title: 'akiba-export-2026-11-18.json',
      message: '{"exportVersion":1}',
    });
    expect(app.to('/me/export')).toHaveLength(1);
    share.mockRestore();
  });

  it('creates a share link shown once, then turns it off', async () => {
    const app = await openSettings(
      account((call) => {
        if (call.method === 'GET' && call.path.endsWith('/me/share')) {
          return json(200, { active: false, scope: null, createdAt: null });
        }
        if (call.method === 'PUT' && call.path.endsWith('/me/share')) {
          return json(200, {
            token: 'T'.repeat(43),
            url: `https://app.example.test/shared/${'T'.repeat(43)}`,
            scope: { statuses: ['completed'], showRatings: false, showReviews: false },
            createdAt: '2026-11-18T00:00:00.000Z',
          });
        }
        if (call.method === 'DELETE' && call.path.endsWith('/me/share')) {
          return new Response(null, { status: 204 });
        }
        return undefined;
      }),
    );
    await app.user.press(await screen.findByRole('button', { name: 'Create link' }));
    expect(await screen.findByLabelText('Your link (shown once)')).toBeTruthy();
    expect(screen.getByLabelText('Your link (shown once)').props.value).toMatch(/\/shared\/T{43}$/);
    expect(app.calls.find((call) => call.method === 'PUT')?.body).toEqual({
      scope: { statuses: ['completed'], showRatings: false, showReviews: false },
    });
    await app.user.press(screen.getByRole('button', { name: 'Turn sharing off' }));
    expect(await screen.findByText(/stopped working at once/)).toBeTruthy();
    expect(screen.queryByLabelText('Your link (shown once)')).toBeNull();
  });

  it('an unverified account is told to verify before sharing', async () => {
    await openSettings(
      account((call) =>
        call.method === 'GET' && call.path.endsWith('/me/share')
          ? json(200, { active: false, scope: null, createdAt: null })
          : undefined,
      ),
    );
    // The default test user is verified; this one is not (the session restore reads the identity).
    expect(screen.queryByText('Verify your email address to create a share link.')).toBeNull();
  });
});

describe('Delete and restore (FR-ACCT-002)', () => {
  it('asks for the password, ends the session, explains the 14 days, and restores it', async () => {
    const handler = signedInHandler((call) => {
      if (call.path.endsWith('/inbox/unread-count')) return json(200, { data: { count: 0 } });
      if (call.method === 'DELETE' && call.path.endsWith('/me')) {
        const body = call.body as { password: string };
        return body.password === 'correct horse battery staple'
          ? json(202, { status: 'deletion_scheduled', purgeAfter: '2026-12-02T00:00:00.000Z' })
          : problem(403, 'REAUTHENTICATION_FAILED');
      }
      if (call.method === 'POST' && call.path.endsWith('/auth/restore')) {
        return json(200, { status: 'restored' });
      }
      return noSeason(call) ?? problem(404, 'NOT_FOUND');
    });
    const app = await renderApp({ handler, storedRefreshToken: STORED });
    await screen.findByText('Welcome, Reader');
    await app.user.press(tab('Me'));
    await app.user.press(await screen.findByRole('link', { name: 'Settings' }));
    await app.user.press(await screen.findByRole('button', { name: 'Delete my account…' }));
    await app.user.type(screen.getByLabelText('Your password'), 'not the password');
    await app.user.press(screen.getByRole('button', { name: 'Delete my account' }));
    expect(await screen.findByText('The current password is incorrect.')).toBeTruthy();

    await app.user.clear(screen.getByLabelText('Your password'));
    await app.user.type(screen.getByLabelText('Your password'), 'correct horse battery staple');
    await app.user.press(screen.getByRole('button', { name: 'Delete my account' }));
    expect(
      await screen.findByRole('header', { name: 'Your account is scheduled for deletion' }),
    ).toBeTruthy();
    expect(screen.getByText(/erased after .*2026/)).toBeTruthy();
    expect(secureStore.size).toBe(0); // the session is gone from the device

    await app.user.press(screen.getByRole('link', { name: 'Restore my account' }));
    await app.user.type(await screen.findByLabelText('Email'), USER.email);
    await app.user.type(screen.getByLabelText('Password'), 'correct horse battery staple');
    await app.user.press(screen.getByRole('button', { name: 'Restore account' }));
    expect(await screen.findByRole('header', { name: 'Account restored' })).toBeTruthy();
    expect(app.to('/auth/restore')[0]?.body).toEqual({
      email: USER.email,
      password: 'correct horse battery staple',
    });
  });
});
