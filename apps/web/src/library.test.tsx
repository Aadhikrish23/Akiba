import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  countText,
  json,
  problem,
  renderApp,
  signedInHandler,
  violations,
  type Call,
} from './test/render';

/**
 * T18: Library, Home ("Continue watching" +1), the shelf panel on the title page and History.
 * FR-LIB-001…007, FR-TRK-001…005, FR-REM-001…005; doc 08 key flows 1–4, §5 states, §6 accessibility.
 */

const ENTRY = '11111111-1111-4111-8111-111111111111';
const TITLE = '00000000-0000-4000-8000-000000000001';

const card = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  kind: 'tv',
  titleRomaji: `Show ${n}`,
  titleEnglish: null,
  titleNative: null,
  coverUrl: null,
  format: 'TV',
  status: 'finished',
  episodesTotal: 12,
  season: 'fall',
  seasonYear: 2024,
  averageScore: 80,
  libraryStatus: 'watching',
  libraryEntryId: `00000000-aaaa-4000-8000-${String(n).padStart(12, '0')}`,
  ...extra,
});

const entry = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `00000000-aaaa-4000-8000-${String(n).padStart(12, '0')}`,
  title: card(n),
  status: 'watching',
  progress: 3,
  effectiveTotal: 12,
  totalOverridden: false,
  rating: null,
  isFavorite: false,
  alertsEnabled: null,
  startedAt: '2026-11-01T00:00:00.000Z',
  completedAt: null,
  addedAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-02T00:00:00.000Z',
  ...extra,
});

const detail = (n: number, extra: Record<string, unknown> = {}) => ({
  ...entry(n),
  review: null,
  notes: null,
  runs: [
    {
      id: '33333333-3333-4333-8333-333333333331',
      runNumber: 1,
      startedAt: '2026-11-01T00:00:00.000Z',
      finishedAt: null,
      rating: null,
      progressAtEnd: null,
    },
  ],
  ...extra,
});

const list = (entries: unknown[]) => json(200, { data: entries, nextCursor: null });
const query = (call: Call) => new URLSearchParams(call.search);
const server = (routes: (call: Call) => Response | undefined) =>
  signedInHandler({}, (call) => routes(call) ?? problem(404, 'NOT_FOUND'));

const COUNTS = { watching: 2, completed: 1, planned: 0, on_hold: 0, dropped: 0, favorites: 1 };

describe('Home: continue watching (doc 08 key flow 1)', () => {
  it('shows each show being watched with its count and a +1 button', async () => {
    renderApp({
      route: '/',
      handler: server((call) =>
        call.path.endsWith('/library') ? list([entry(1), entry(2, { progress: 11 })]) : undefined,
      ),
    });
    expect(await screen.findByRole('heading', { name: 'Continue watching' })).toBeTruthy();
    const cards = await screen.findAllByRole('article');
    expect(cards).toHaveLength(2);
    expect(countText(within(cards[0]!).getByTestId('episode-count'))).toBe('3 / 12');
    expect(within(cards[0]!).getByRole('button', { name: '+1 episode of Show 1' })).toBeTruthy();
  });

  it('+1 changes the count at once, then the server confirms', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = renderApp({
      route: '/',
      handler: async (call) => {
        if (call.path.endsWith('/auth/refresh'))
          return json(200, { accessToken: 'a', tokenType: 'Bearer', expiresIn: 900 });
        if (call.path.endsWith('/me')) return json(200, (await import('./test/render')).USER);
        if (call.path.endsWith('/library')) return list([entry(1)]);
        if (call.path.endsWith('/progress')) {
          await gate;
          return json(200, { data: detail(1, { progress: 4 }), suggestComplete: false });
        }
        return problem(404, 'NOT_FOUND');
      },
    });
    await app.user.click(await screen.findByRole('button', { name: '+1 episode of Show 1' }));
    // Optimistic: the number moved before the server answered.
    expect(countText(screen.getByTestId('episode-count'))).toBe('4 / 12');
    release();
    await waitFor(() => {
      expect(app.to('/progress')).toHaveLength(1);
    });
    expect(app.to('/progress')[0]?.body).toEqual({ delta: 1 });
    expect(countText(screen.getByTestId('episode-count'))).toBe('4 / 12');
  });

  it('puts the count back and says why when the server refuses', async () => {
    const app = renderApp({
      route: '/',
      handler: server((call) => {
        if (call.path.endsWith('/library')) return list([entry(1)]);
        if (call.path.endsWith('/progress')) return problem(500, 'INTERNAL_ERROR');
        return undefined;
      }),
    });
    await app.user.click(await screen.findByRole('button', { name: '+1 episode of Show 1' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /Something went wrong on our side/,
    );
    expect(countText(screen.getByTestId('episode-count'))).toBe('3 / 12');
  });

  it('at the final episode asks "Mark completed?" inline, and completing hides +1', async () => {
    const app = renderApp({
      route: '/',
      handler: server((call) => {
        if (call.path.endsWith('/library')) return list([entry(1, { progress: 11 })]);
        if (call.path.endsWith('/progress'))
          return json(200, { data: detail(1, { progress: 12 }), suggestComplete: true });
        if (call.method === 'PATCH')
          return json(200, detail(1, { progress: 12, status: 'completed' }));
        return undefined;
      }),
    });
    await app.user.click(await screen.findByRole('button', { name: '+1 episode of Show 1' }));
    expect(await screen.findByText('That was the last episode. Mark completed?')).toBeTruthy();
    await app.user.click(screen.getByRole('button', { name: 'Yes, mark completed' }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '+1 episode of Show 1' })).toBeNull();
    });
    expect(app.calls.find((call) => call.method === 'PATCH')?.body).toEqual({
      status: 'completed',
    });
  });

  describe('typing the episode count (catching up without pressing +1 a thousand times)', () => {
    const serving = (shows: unknown[], onProgress?: (call: Call) => Response) =>
      server((call) => {
        if (call.path.endsWith('/library')) return list(shows);
        if (call.path.endsWith('/progress') && onProgress !== undefined) return onProgress(call);
        return undefined;
      });
    const counter = () => within(screen.getByTestId('episode-count')).getByRole('textbox');

    it('saves what you type when you click away, in one request', async () => {
      const app = renderApp({
        route: '/',
        handler: serving([entry(1)], () =>
          json(200, { data: detail(1, { progress: 9 }), suggestComplete: false }),
        ),
      });
      await screen.findByTestId('episode-count');
      await app.user.clear(counter());
      await app.user.type(counter(), '9');
      await app.user.tab();
      await waitFor(() => {
        expect(app.to('/progress')).toHaveLength(1);
      });
      expect(app.to('/progress')[0]?.body).toEqual({ set: 9 });
      expect(countText(screen.getByTestId('episode-count'))).toBe('9 / 12');
    });

    it('Enter saves, and Escape puts the old number back without asking the server', async () => {
      const app = renderApp({
        route: '/',
        handler: serving([entry(1)], () =>
          json(200, { data: detail(1, { progress: 7 }), suggestComplete: false }),
        ),
      });
      await screen.findByTestId('episode-count');
      await app.user.clear(counter());
      await app.user.type(counter(), '5{Escape}');
      expect(countText(screen.getByTestId('episode-count'))).toBe('3 / 12');
      expect(app.to('/progress')).toHaveLength(0);

      await app.user.clear(counter());
      await app.user.type(counter(), '7{Enter}');
      await waitFor(() => {
        expect(app.to('/progress')).toHaveLength(1);
      });
      expect(app.to('/progress')[0]?.body).toEqual({ set: 7 });
    });

    it('explains a number past the total and does not save it', async () => {
      const app = renderApp({ route: '/', handler: serving([entry(1)]) });
      await screen.findByTestId('episode-count');
      await app.user.clear(counter());
      await app.user.type(counter(), '13');
      expect((await screen.findByRole('alert')).textContent).toBe('This show has 12 episodes.');
      await app.user.tab();
      expect(app.to('/progress')).toHaveLength(0);
      expect(countText(screen.getByTestId('episode-count'))).toBe('3 / 12');
    });

    it('a running show with no total counts up to what has aired, and no further', async () => {
      const running = entry(1, { progress: 21, effectiveTotal: null, episodesAired: 1180 });
      const app = renderApp({
        route: '/',
        handler: serving([running], () =>
          json(200, {
            data: detail(1, { progress: 1180, effectiveTotal: null, episodesAired: 1180 }),
            suggestComplete: false,
          }),
        ),
      });
      await screen.findByTestId('episode-count');
      expect(countText(screen.getByTestId('episode-count'))).toBe('21 / 1180');

      await app.user.clear(counter());
      await app.user.type(counter(), '1181');
      expect((await screen.findByRole('alert')).textContent).toBe(
        'Only 1180 episodes have aired so far.',
      );
      await app.user.clear(counter());
      await app.user.type(counter(), '1180{Enter}');
      await waitFor(() => {
        expect(app.to('/progress')).toHaveLength(1);
      });
      expect(app.to('/progress')[0]?.body).toEqual({ set: 1180 });
      // Caught up: nothing to add with +1 until the next episode airs.
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: '+1 episode of Show 1' })).toBeNull();
      });
    });

    it('puts the number back and says why when the server refuses', async () => {
      const app = renderApp({
        route: '/',
        handler: serving([entry(1)], () => problem(500, 'INTERNAL_ERROR')),
      });
      await screen.findByTestId('episode-count');
      await app.user.clear(counter());
      await app.user.type(counter(), '8{Enter}');
      expect((await screen.findByRole('alert')).textContent).toMatch(
        /Something went wrong on our side/,
      );
      expect(countText(screen.getByTestId('episode-count'))).toBe('3 / 12');
    });

    it('is read-only once the title is completed', async () => {
      renderApp({
        route: '/',
        handler: serving([entry(1, { status: 'completed', progress: 12 })]),
      });
      await screen.findByTestId('episode-count');
      expect((counter() as HTMLInputElement).readOnly).toBe(true);
    });
  });

  it('says what to do when nothing is in progress', async () => {
    renderApp({
      route: '/',
      handler: server((call) => (call.path.endsWith('/library') ? list([]) : undefined)),
    });
    expect(await screen.findByText(/Nothing in progress/)).toBeTruthy();
  });
});

describe('Library (FR-LIB-003…005)', () => {
  const library = server((call) => {
    if (call.path.endsWith('/library/counts')) return json(200, { data: COUNTS });
    if (call.path.endsWith('/library/favorites')) return list([entry(1)]);
    if (call.path.endsWith('/library'))
      return list([entry(1), entry(2, { status: 'completed', rating: 9 })]);
    return undefined;
  });

  it('shows tabs with counts and the entries as posters', async () => {
    renderApp({ route: '/library', handler: library });
    const tabs = await screen.findByRole('navigation', { name: 'Library sections' });
    expect(await within(tabs).findByRole('button', { name: /^Watching\s*2$/ })).toBeTruthy();
    expect(within(tabs).getByRole('button', { name: /^All\s*3$/ })).toBeTruthy();
    expect(
      within(await screen.findByRole('list', { name: 'Library' })).getAllByRole('article'),
    ).toHaveLength(2);
  });

  it('a tab asks for that status, and favorites use their own list', async () => {
    const app = renderApp({ route: '/library', handler: library });
    const tabs = await screen.findByRole('navigation', { name: 'Library sections' });
    await app.user.click(within(tabs).getByRole('button', { name: /^Completed/ }));
    await waitFor(() => {
      expect(query(app.to('/library').at(-1)!).get('status')).toBe('completed');
    });
    await app.user.click(within(tabs).getByRole('button', { name: /^Favorites/ }));
    await waitFor(() => {
      expect(app.to('/library/favorites').length).toBeGreaterThan(0);
    });
  });

  it('searches and sorts through the API', async () => {
    const app = renderApp({ route: '/library', handler: library });
    await screen.findByRole('list', { name: 'Library' });
    await app.user.selectOptions(screen.getByLabelText('Sort by'), 'rating');
    await app.user.type(screen.getByLabelText('Search your library'), 'show{enter}');
    await waitFor(() => {
      const last = query(app.to('/library').at(-1)!);
      expect(last.get('sort')).toBe('rating');
      expect(last.get('q')).toBe('show');
    });
  });

  it('remembers the layout on the account and switches to the compact list', async () => {
    const app = renderApp({
      route: '/library',
      handler: server((call) => {
        if (call.path.endsWith('/library/counts')) return json(200, { data: COUNTS });
        if (call.path.endsWith('/library')) return list([entry(1)]);
        if (call.method === 'PATCH' && call.path.endsWith('/me')) {
          return json(200, {
            id: '3f2b8c1e-5a47-4d0e-9d57-0c5d9a3b7e11',
            email: 'reader@example.test',
            displayName: 'Reader',
            emailVerified: true,
            titleLanguage: 'romaji',
            timeZone: 'UTC',
            libraryView: 'list',
            alertsEnabled: true,
            showAdult: false,
            createdAt: '2026-11-01T00:00:00.000Z',
          });
        }
        return undefined;
      }),
    });
    await app.user.click(await screen.findByRole('radio', { name: 'List' }));
    await waitFor(() => {
      expect(app.calls.find((call) => call.method === 'PATCH')?.body).toEqual({
        libraryView: 'list',
      });
    });
    const rows = await within(await screen.findByRole('list', { name: 'Library' })).findAllByRole(
      'listitem',
    );
    expect(rows).toHaveLength(1);
    expect(within(rows[0]!).getByRole('button', { name: '+1 episode of Show 1' })).toBeTruthy();
  });

  it('empty library: one sentence and one action; filtered-empty says to remove a filter', async () => {
    renderApp({
      route: '/library',
      handler: server((call) =>
        call.path.endsWith('/library/counts')
          ? json(200, { data: { ...COUNTS, watching: 0 } })
          : call.path.endsWith('/library')
            ? list([])
            : undefined,
      ),
    });
    expect(await screen.findByText(/Your library is empty/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Find something to watch' }).getAttribute('href')).toBe(
      '/discover',
    );
  });

  it('is free of automatically detectable accessibility problems (grid)', async () => {
    const app = renderApp({ route: '/library', handler: library });
    await screen.findByRole('list', { name: 'Library' });
    expect(await violations(app.container)).toEqual([]);
  });
});

describe('The shelf panel on a title page (doc 08 key flows 2–4)', () => {
  const titlePage = (
    libraryEntryId: string | null,
    extra: (call: Call) => Response | undefined = () => undefined,
  ) =>
    server((call) => {
      if (call.path.endsWith('/relations'))
        return json(200, { data: [], meta: { stale: false, source: 'cache' } });
      if (call.path.endsWith(`/titles/${TITLE}`)) {
        return json(200, {
          data: {
            ...card(1, {
              libraryEntryId,
              libraryStatus: libraryEntryId === null ? null : 'watching',
            }),
            synopsis: null,
            bannerUrl: null,
            durationMin: 24,
            startDate: null,
            endDate: null,
            popularity: 1,
            synonyms: [],
            genres: [],
            studios: [],
            nextAiring: null,
            franchiseId: null,
          },
          meta: { stale: false, source: 'cache' },
        });
      }
      return extra(call);
    });

  it('adds the title with the chosen status', async () => {
    const app = renderApp({
      route: `/title/${TITLE}`,
      handler: titlePage(null, (call) =>
        call.method === 'POST' && call.path.endsWith('/library')
          ? json(201, { data: detail(1) })
          : undefined,
      ),
    });
    await screen.findByRole('heading', { name: 'Add to your library' });
    await app.user.selectOptions(screen.getByLabelText('Status'), 'watching');
    await app.user.click(screen.getByRole('button', { name: 'Add to library' }));
    expect(await screen.findByRole('heading', { name: 'On your shelf' })).toBeTruthy();
    expect(
      app.calls.find((call) => call.method === 'POST' && call.path.endsWith('/library'))?.body,
    ).toEqual({ titleId: TITLE, status: 'watching' });
  });

  const shelf = (
    overrides: Record<string, unknown> = {},
    extra: (call: Call) => Response | undefined = () => undefined,
  ) =>
    titlePage(ENTRY, (call) => {
      if (call.path.endsWith(`/library/${ENTRY}`) && call.method === 'GET')
        return json(200, { data: detail(1, overrides) });
      return extra(call);
    });

  it('rates, marks a favorite and saves a review', async () => {
    const app = renderApp({
      route: `/title/${TITLE}`,
      handler: shelf({}, (call) =>
        call.method === 'PATCH'
          ? json(200, { data: detail(1, call.body as Record<string, unknown>) })
          : undefined,
      ),
    });
    await screen.findByRole('heading', { name: 'On your shelf' });
    await app.user.selectOptions(screen.getByLabelText('Your rating'), '8');
    await waitFor(() => {
      expect(app.calls.find((call) => call.method === 'PATCH')?.body).toEqual({ rating: 8 });
    });
    await app.user.click(screen.getByLabelText('Favorite'));
    await app.user.type(screen.getByLabelText('Your review (private)'), 'Lovely');
    await app.user.click(screen.getByRole('button', { name: 'Save review' }));
    await waitFor(() => {
      expect(
        app.calls.filter((call) => call.method === 'PATCH').map((call) => call.body),
      ).toContainEqual({ review: 'Lovely' });
    });
  });

  it('lets the reader turn episode alerts on or off for one title, or follow the account (FR-NOTE-004)', async () => {
    const app = renderApp({
      route: `/title/${TITLE}`,
      handler: shelf({}, (call) =>
        call.method === 'PATCH'
          ? json(200, { data: detail(1, call.body as Record<string, unknown>) })
          : undefined,
      ),
    });
    const select = await screen.findByLabelText('Episode alerts for this title');
    expect((select as HTMLSelectElement).value).toBe(''); // follows the account
    await app.user.selectOptions(select, 'Off');
    await waitFor(() => {
      expect(app.calls.find((call) => call.method === 'PATCH')?.body).toEqual({
        alertsEnabled: false,
      });
    });
    await app.user.selectOptions(screen.getByLabelText('Episode alerts for this title'), 'On');
    await app.user.selectOptions(
      screen.getByLabelText('Episode alerts for this title'),
      'Follow my account setting',
    );
    await waitFor(() => {
      expect(app.calls.filter((call) => call.method === 'PATCH').map((call) => call.body)).toEqual([
        { alertsEnabled: false },
        { alertsEnabled: true },
        { alertsEnabled: null },
      ]);
    });
  });

  it('offers no alert setting for a title that is not being watched', async () => {
    renderApp({ route: `/title/${TITLE}`, handler: shelf({ status: 'completed' }) });
    await screen.findByRole('heading', { name: 'On your shelf' });
    expect(screen.queryByLabelText('Episode alerts for this title')).toBeNull();
  });

  it('edits the episode count, shows it as Edited, and resets it', async () => {
    const app = renderApp({
      route: `/title/${TITLE}`,
      handler: shelf({}, (call) => {
        if (call.method === 'PUT')
          return json(200, { data: detail(1, { effectiveTotal: 24, totalOverridden: true }) });
        if (call.method === 'DELETE') return json(200, { data: detail(1) });
        return undefined;
      }),
    });
    await app.user.click(await screen.findByRole('button', { name: 'Episode count looks wrong?' }));
    const field = screen.getByLabelText('Number of episodes');
    await app.user.clear(field);
    await app.user.type(field, '24');
    await app.user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Edited')).toBeTruthy();
    expect(app.calls.find((call) => call.method === 'PUT')?.body).toEqual({ total: 24 });
    await app.user.click(screen.getByRole('button', { name: /^Reset to/ }));
    await waitFor(() => {
      expect(screen.queryByText('Edited')).toBeNull();
    });
  });

  it('a completed title offers Rewatch, and the new run appears in the viewings', async () => {
    const app = renderApp({
      route: `/title/${TITLE}`,
      handler: shelf(
        {
          status: 'completed',
          progress: 12,
          runs: [
            {
              id: '33333333-3333-4333-8333-333333333331',
              runNumber: 1,
              startedAt: '2026-11-01T00:00:00.000Z',
              finishedAt: '2026-11-05T00:00:00.000Z',
              rating: 8,
              progressAtEnd: 12,
            },
          ],
        },
        (call) =>
          call.method === 'POST' && call.path.endsWith('/runs')
            ? json(201, {
                data: detail(1, {
                  progress: 0,
                  runs: [
                    {
                      id: '33333333-3333-4333-8333-333333333331',
                      runNumber: 1,
                      startedAt: '2026-11-01T00:00:00.000Z',
                      finishedAt: '2026-11-05T00:00:00.000Z',
                      rating: 8,
                      progressAtEnd: 12,
                    },
                    {
                      id: '33333333-3333-4333-8333-333333333332',
                      runNumber: 2,
                      startedAt: '2026-11-18T00:00:00.000Z',
                      finishedAt: null,
                      rating: null,
                      progressAtEnd: null,
                    },
                  ],
                }),
              })
            : undefined,
      ),
    });
    await app.user.click(await screen.findByRole('button', { name: 'Rewatch' }));
    const viewings = await screen.findByRole('list', { name: 'Viewings' });
    expect(within(viewings).getAllByRole('listitem')).toHaveLength(2);
    expect(within(viewings).getByText(/Run 2: started 2026-11-18, in progress/)).toBeTruthy();
    expect(within(viewings).getByText(/Run 1: .*finished 2026-11-05, rated 8 \/ 10/)).toBeTruthy();
  });

  it('removing asks first, keeps the history, and returns to "Add to your library"', async () => {
    const app = renderApp({
      route: `/title/${TITLE}`,
      handler: shelf({}, (call) =>
        call.method === 'DELETE' ? new Response(null, { status: 204 }) : undefined,
      ),
    });
    await app.user.click(await screen.findByRole('button', { name: 'Remove from library' }));
    expect(screen.getByRole('alert').textContent).toMatch(/Your history is kept/);
    await app.user.click(screen.getByRole('button', { name: 'Yes, remove it' }));
    expect(await screen.findByRole('heading', { name: 'Add to your library' })).toBeTruthy();
  });

  it('says so when a change is refused', async () => {
    const app = renderApp({
      route: `/title/${TITLE}`,
      handler: shelf({}, (call) =>
        call.method === 'PATCH' ? problem(409, 'CONFLICT') : undefined,
      ),
    });
    await screen.findByRole('heading', { name: 'On your shelf' });
    await app.user.selectOptions(screen.getByLabelText('Your rating'), '5');
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('is free of automatically detectable accessibility problems', async () => {
    const app = renderApp({ route: `/title/${TITLE}`, handler: shelf() });
    await screen.findByRole('heading', { name: 'On your shelf' });
    expect(await violations(app.container)).toEqual([]);
  });
});

describe('History (FR-REM-003)', () => {
  const event = (
    n: number,
    type: string,
    payload: Record<string, unknown>,
    occurredAt: string,
  ) => ({
    id: `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`,
    type,
    occurredAt,
    payload,
    entryId: ENTRY,
    title: card(1),
  });
  const history = server((call) =>
    call.path.endsWith('/history')
      ? json(200, {
          data: [
            event(3, 'rated', { from: null, to: 9 }, '2026-11-18T12:00:00.000Z'),
            event(2, 'progress_changed', { from: 2, to: 3, run: 1 }, '2026-11-18T11:00:00.000Z'),
            event(1, 'entry_added', { status: 'watching' }, '2026-11-17T10:00:00.000Z'),
          ],
          nextCursor: null,
        })
      : undefined,
  );

  it('lists events as sentences, grouped by day, newest first', async () => {
    renderApp({ route: '/history', handler: history });
    expect(await screen.findByText('Rated 9 out of 10')).toBeTruthy();
    expect(screen.getByText('Watched episode 3')).toBeTruthy();
    expect(screen.getByText('Added to your library as Watching')).toBeTruthy();
    expect(screen.getAllByRole('region')).toHaveLength(2); // two days
    expect(screen.getAllByRole('link', { name: 'Show 1' })).toHaveLength(3);
  });

  it('filters by kind of event through the API', async () => {
    const app = renderApp({ route: '/history', handler: history });
    await screen.findByText('Rated 9 out of 10');
    await app.user.selectOptions(screen.getByLabelText('Show'), 'rated');
    await waitFor(() => {
      expect(query(app.to('/history').at(-1)!).get('type')).toBe('rated');
    });
  });

  it('says what to do when there is nothing yet', async () => {
    renderApp({
      route: '/history',
      handler: server((call) =>
        call.path.endsWith('/history') ? json(200, { data: [], nextCursor: null }) : undefined,
      ),
    });
    expect(await screen.findByText(/Nothing here yet/)).toBeTruthy();
  });

  it('is free of automatically detectable accessibility problems', async () => {
    const app = renderApp({ route: '/history', handler: history });
    await screen.findByText('Rated 9 out of 10');
    expect(await violations(app.container)).toEqual([]);
  });
});
