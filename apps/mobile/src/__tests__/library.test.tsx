import { fireEvent, waitFor as rntlWaitFor } from '@testing-library/react-native';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
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

/**
 * T27: Home's "Continue watching" with +1, the library (sections, search, sort, grid and list), the
 * shelf on the title screen, and History, with the real router, API client and providers over a fake
 * network. FR-LIB-001…007, FR-TRK-001…005, FR-REM-001…005; doc 08 key flows 1–4.
 */

const STORED = 'S'.repeat(43);
const ENTRY = '11111111-1111-4111-8111-111111111111';
const TITLE = '00000000-0000-4000-8000-000000000001';
const META = { stale: false, source: 'cache' };

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

const list = (entries: unknown[], extra: Record<string, unknown> = {}) =>
  json(200, { data: entries, nextCursor: null, ...extra });
const query = (call: Call) => new URLSearchParams(call.search);
const server = (routes: (call: Call) => Response | undefined, overrides = {}): Handler =>
  signedInHandler((call) => routes(call) ?? problem(404, 'NOT_FOUND'), overrides);
const flatten = (style: unknown) => StyleSheet.flatten(style as StyleProp<ViewStyle>);
const COUNTS = { watching: 2, completed: 1, planned: 0, on_hold: 0, dropped: 0, favorites: 1 };
const noSeason = (call: Call) =>
  call.path.includes('/seasons/')
    ? json(200, { data: [], nextCursor: null, meta: META, season: 'fall', seasonYear: 2026 })
    : undefined;

describe('Home: continue watching (doc 08 key flow 1)', () => {
  it('shows each show being watched with its count and a +1 button', async () => {
    await renderApp({
      handler: server((call) =>
        call.path.endsWith('/library')
          ? list([entry(1), entry(2, { progress: 11 })])
          : noSeason(call),
      ),
      storedRefreshToken: STORED,
    });
    expect(await screen.findByRole('header', { name: 'Continue watching' })).toBeTruthy();
    expect(screen.getByLabelText('3 of 12 episodes')).toBeTruthy();
    expect(screen.getByLabelText('11 of 12 episodes')).toBeTruthy();
    expect(screen.getByRole('button', { name: '+1 episode of Show 1' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /^Show 1, Watching/ })).toBeTruthy();
    expect(
      screen.getByRole('progressbar', { name: 'Progress in Show 1' }).props.accessibilityValue,
    ).toMatchObject({ now: 3, max: 12 });
  });

  it('+1 moves the count at once, then the server confirms (rapid taps each count)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = await renderApp({
      handler: signedInHandler(async (call) => {
        if (call.path.endsWith('/library')) return list([entry(1)]);
        if (call.path.endsWith('/progress')) {
          await gate;
          return json(200, { data: detail(1, { progress: 4 }), suggestComplete: false });
        }
        return noSeason(call) ?? problem(404, 'NOT_FOUND');
      }),
      storedRefreshToken: STORED,
    });
    await app.user.press(await screen.findByRole('button', { name: '+1 episode of Show 1' }));
    // Optimistic: the number moved before the server answered.
    expect(screen.getByLabelText('4 of 12 episodes')).toBeTruthy();
    release();
    await waitFor(() => app.to('/progress').length === 1);
    expect(app.to('/progress')[0]?.body).toEqual({ delta: 1 });
    expect(screen.getByLabelText('4 of 12 episodes')).toBeTruthy();
  });

  it('puts the count back and says why when the server refuses', async () => {
    const app = await renderApp({
      handler: server((call) =>
        call.path.endsWith('/library')
          ? list([entry(1)])
          : call.path.endsWith('/progress')
            ? problem(500, 'INTERNAL_ERROR')
            : noSeason(call),
      ),
      storedRefreshToken: STORED,
    });
    await app.user.press(await screen.findByRole('button', { name: '+1 episode of Show 1' }));
    expect(await screen.findByText(/Something went wrong on our side/)).toBeTruthy();
    expect(screen.getByLabelText('3 of 12 episodes')).toBeTruthy();
  });

  it('at the final episode asks "Mark completed?" inline, and completing hides +1', async () => {
    const app = await renderApp({
      handler: server((call) => {
        if (call.method === 'PATCH') {
          return json(200, detail(1, { progress: 12, status: 'completed' }));
        }
        if (call.path.endsWith('/library')) return list([entry(1, { progress: 11 })]);
        if (call.path.endsWith('/progress')) {
          return json(200, { data: detail(1, { progress: 12 }), suggestComplete: true });
        }
        return noSeason(call);
      }),
      storedRefreshToken: STORED,
    });
    await app.user.press(await screen.findByRole('button', { name: '+1 episode of Show 1' }));
    expect(await screen.findByText('That was the last episode. Mark completed?')).toBeTruthy();
    await app.user.press(screen.getByRole('button', { name: 'Yes, mark completed' }));
    await waitFor(() => screen.queryByRole('button', { name: '+1 episode of Show 1' }) === null);
    expect(app.calls.find((call) => call.method === 'PATCH')?.body).toEqual({
      status: 'completed',
    });
  });

  it('says what to do when nothing is in progress', async () => {
    await renderApp({
      handler: server((call) => (call.path.endsWith('/library') ? list([]) : noSeason(call))),
      storedRefreshToken: STORED,
    });
    expect(await screen.findByText(/Nothing in progress/)).toBeTruthy();
  });
});

/** Wait until `condition` holds (the screens update after the network answers), inside `act`. */
const waitFor = (condition: () => boolean) =>
  rntlWaitFor(() => {
    if (!condition()) throw new Error('not yet');
  });

describe('Library (FR-LIB-003…005)', () => {
  const library = server((call) => {
    if (call.path.endsWith('/library/counts')) return json(200, { data: COUNTS });
    if (call.path.endsWith('/library/favorites')) return list([entry(1)]);
    if (call.path.endsWith('/library')) {
      return list([entry(1), entry(2, { status: 'completed', rating: 9, progress: 12 })]);
    }
    return noSeason(call);
  });

  async function openLibrary(handler: Handler = library) {
    const app = await renderApp({ handler, storedRefreshToken: STORED });
    await screen.findByText('Welcome, Reader');
    await app.user.press(tab('Library'));
    return app;
  }

  it('shows sections with counts and the entries as posters, named with their progress', async () => {
    await openLibrary();
    expect(await screen.findByRole('radio', { name: 'Watching 2' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'All 3' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Favorites 1' })).toBeTruthy();
    expect(
      await screen.findByRole('link', { name: 'Show 1, Watching, 3 of 12 episodes' }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Show 2, Completed, 12 of 12 episodes' })).toBeTruthy();
  });

  it('a section asks for that status, and favorites use their own list', async () => {
    const app = await openLibrary();
    await app.user.press(await screen.findByRole('radio', { name: 'Completed 1' }));
    await waitFor(() => query(app.to('/library').at(-1)!).get('status') === 'completed');
    await app.user.press(screen.getByRole('radio', { name: 'Favorites 1' }));
    await waitFor(() => app.to('/library/favorites').length > 0);
  });

  it('searches and sorts through the API', async () => {
    const app = await openLibrary();
    await screen.findByRole('link', { name: /^Show 1/ });
    await app.user.press(screen.getByRole('radio', { name: 'Rating' }));
    await app.user.type(screen.getByLabelText('Search your library'), 'show');
    await app.user.press(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => {
      const last = query(app.to('/library').at(-1)!);
      return last.get('sort') === 'rating' && last.get('q') === 'show';
    });
  });

  it('remembers the layout on the account and switches to rows with +1', async () => {
    const app = await openLibrary(
      server((call) => {
        if (call.method === 'PATCH' && call.path.endsWith('/me')) {
          return json(200, { ...USER, libraryView: 'list' });
        }
        if (call.path.endsWith('/library/counts')) return json(200, { data: COUNTS });
        if (call.path.endsWith('/library')) return list([entry(1)]);
        return noSeason(call);
      }),
    );
    await screen.findByRole('link', { name: /^Show 1/ });
    expect(screen.queryByRole('button', { name: '+1 episode of Show 1' })).toBeNull(); // grid
    await app.user.press(screen.getByRole('radio', { name: 'List' }));
    await waitFor(() => app.calls.some((call) => call.method === 'PATCH'));
    expect(app.calls.find((call) => call.method === 'PATCH')?.body).toEqual({
      libraryView: 'list',
    });
    expect(await screen.findByRole('button', { name: '+1 episode of Show 1' })).toBeTruthy();
  });

  it('opens a title from the library', async () => {
    const app = await openLibrary(
      server((call) => {
        if (call.path.endsWith('/library/counts')) return json(200, { data: COUNTS });
        if (call.path.endsWith('/library')) return list([entry(1)]);
        if (call.path.endsWith('/relations') || call.path.endsWith('/characters')) {
          return json(200, { data: [], meta: META });
        }
        if (call.path.endsWith(`/titles/${TITLE}`)) {
          return json(200, { data: titleDetail(1), meta: META });
        }
        return noSeason(call);
      }),
    );
    await app.user.press(await screen.findByRole('link', { name: /^Show 1/ }));
    expect(await screen.findByRole('header', { name: 'Show 1' })).toBeTruthy();
  });

  it('an empty library says what to do; a search with no match says to remove a filter', async () => {
    const app = await openLibrary(
      server((call) => {
        if (call.path.endsWith('/library/counts')) {
          return json(200, { data: { ...COUNTS, watching: 0, completed: 0, favorites: 0 } });
        }
        if (call.path.endsWith('/library')) return list([]);
        return noSeason(call);
      }),
    );
    expect(await screen.findByText(/Your library is empty/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Find something to watch' })).toBeTruthy();
    await app.user.type(screen.getByLabelText('Search your library'), 'nothing');
    await app.user.press(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText(/Nothing in your library matches “nothing”/)).toBeTruthy();
  });

  it('an error offers Try again; paging uses the cursor once', async () => {
    let attempts = 0;
    const app = await openLibrary(
      server((call) => {
        if (call.path.endsWith('/library/counts')) return json(200, { data: COUNTS });
        if (call.path.endsWith('/library')) {
          if (query(call).get('limit') !== '24') return list([]); // Home's own list
          attempts += 1;
          if (attempts === 1) return problem(403, 'FORBIDDEN');
          return query(call).get('cursor') === 'more'
            ? list([entry(3)])
            : list([entry(1), entry(2)], { nextCursor: 'more' });
        }
        return noSeason(call);
      }),
    );
    expect(await screen.findByRole('alert')).toBeTruthy();
    await app.user.press(screen.getByRole('button', { name: 'Try again' }));
    await app.user.press(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('link', { name: /^Show 3/ })).toBeTruthy();
    expect(app.to('/library').filter((call) => query(call).get('cursor') === 'more')).toHaveLength(
      1,
    );
  });
});

/** A title detail whose library entry is `ENTRY` (or none). */
const titleDetail = (n: number, entryId: string | null = null, extra = {}) => ({
  ...card(n, {
    libraryEntryId: entryId,
    libraryStatus: entryId === null ? null : 'watching',
    status: 'finished',
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
  ...extra,
});

describe('The shelf on a title screen (doc 08 key flows 2–4)', () => {
  const titleServer = (
    entryId: string | null,
    extra: (call: Call) => Response | undefined = () => undefined,
  ): Handler =>
    server((call) => {
      if (call.path.endsWith('/relations') || call.path.endsWith('/characters')) {
        return json(200, { data: [], meta: META });
      }
      if (call.path.endsWith(`/titles/${TITLE}`)) {
        return json(200, { data: titleDetail(1, entryId), meta: META });
      }
      return extra(call);
    });

  const shelf = (
    overrides: Record<string, unknown> = {},
    extra: (call: Call) => Response | undefined = () => undefined,
  ): Handler =>
    titleServer(ENTRY, (call) => {
      if (call.path.endsWith(`/library/${ENTRY}`) && call.method === 'GET') {
        return json(200, { data: detail(1, overrides) });
      }
      return extra(call);
    });

  /** PATCH answers with the entry as changed. */
  const patching = (call: Call) =>
    call.method === 'PATCH'
      ? json(200, { data: detail(1, call.body as Record<string, unknown>) })
      : undefined;

  const open = (handler: Handler) =>
    renderApp({ route: `/title/${TITLE}`, handler, storedRefreshToken: STORED });

  it('adds the title with the chosen status', async () => {
    const app = await open(
      titleServer(null, (call) =>
        call.method === 'POST' && call.path.endsWith('/library')
          ? json(201, { data: detail(1) })
          : undefined,
      ),
    );
    await screen.findByRole('header', { name: 'Add to your library' });
    await app.user.press(screen.getByRole('radio', { name: 'Planned' }));
    await app.user.press(screen.getByRole('radio', { name: 'Watching' }));
    await app.user.press(screen.getByRole('button', { name: 'Add to library' }));
    expect(await screen.findByRole('header', { name: 'On your shelf' })).toBeTruthy();
    expect(
      app.calls.find((call) => call.method === 'POST' && call.path.endsWith('/library'))?.body,
    ).toEqual({ titleId: TITLE, status: 'watching' });
  });

  it('rates, marks a favorite and saves a review', async () => {
    const app = await open(shelf({}, patching));
    await screen.findByRole('header', { name: 'On your shelf' });
    await app.user.press(screen.getByRole('radio', { name: '8' }));
    await waitFor(() => app.calls.some((call) => call.method === 'PATCH'));
    expect(app.calls.find((call) => call.method === 'PATCH')?.body).toEqual({ rating: 8 });
    await app.user.press(screen.getByRole('radio', { name: 'Not rated' }));
    await fireEvent(screen.getByLabelText('Favorite'), 'valueChange', true);
    await app.user.type(screen.getByLabelText('Your review (private)'), 'Lovely');
    await app.user.press(screen.getByRole('button', { name: 'Save review' }));
    await waitFor(() =>
      app.calls
        .filter((call) => call.method === 'PATCH')
        .some((call) => JSON.stringify(call.body) === JSON.stringify({ review: 'Lovely' })),
    );
    const bodies = app.calls.filter((call) => call.method === 'PATCH').map((call) => call.body);
    expect(bodies).toContainEqual({ rating: null });
    expect(bodies).toContainEqual({ isFavorite: true });
  });

  it('changes the status, and the episode alert setting only while Watching', async () => {
    const app = await open(shelf({}, patching));
    await screen.findByRole('header', { name: 'On your shelf' });
    expect(screen.getByRole('radio', { name: 'Follow my account setting' })).toBeTruthy();
    await app.user.press(screen.getByRole('radio', { name: 'Off' }));
    await waitFor(() => app.calls.some((call) => call.method === 'PATCH'));
    expect(app.calls.find((call) => call.method === 'PATCH')?.body).toEqual({
      alertsEnabled: false,
    });
    await app.user.press(screen.getByRole('radio', { name: 'Completed' }));
    await waitFor(
      () => screen.queryByRole('radio', { name: 'Follow my account setting' }) === null,
    );
  });

  it('edits the episode count, shows it as Edited, and resets it', async () => {
    const app = await open(
      shelf({}, (call) => {
        if (call.method === 'PUT') {
          return json(200, { data: detail(1, { effectiveTotal: 24, totalOverridden: true }) });
        }
        if (call.method === 'DELETE') return json(200, { data: detail(1) });
        return undefined;
      }),
    );
    await app.user.press(await screen.findByRole('button', { name: 'Episode count looks wrong?' }));
    const field = screen.getByLabelText('Number of episodes');
    await app.user.clear(field);
    await app.user.type(field, '24');
    await app.user.press(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Edited\. The episode count is your own: 24/)).toBeTruthy();
    expect(app.calls.find((call) => call.method === 'PUT')?.body).toEqual({ total: 24 });
    await app.user.press(screen.getByRole('button', { name: /^Reset to/ }));
    await waitFor(() => screen.queryByText(/Edited\./) === null);
  });

  it('a completed title offers Rewatch, and the new run appears in the viewings', async () => {
    const app = await open(
      shelf({ status: 'completed', progress: 12 }, (call) =>
        call.method === 'POST' && call.path.endsWith('/runs')
          ? json(201, {
              data: detail(1, {
                status: 'watching',
                progress: 0,
                runs: [
                  {
                    id: '33333333-3333-4333-8333-333333333331',
                    runNumber: 1,
                    startedAt: '2026-11-01T00:00:00.000Z',
                    finishedAt: '2026-11-05T00:00:00.000Z',
                    rating: 9,
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
    );
    await app.user.press(await screen.findByRole('button', { name: 'Rewatch Show 1' }));
    expect(await screen.findByText(/Run 2: started .*, in progress/)).toBeTruthy();
    expect(screen.getByText(/Run 1: started .*, finished .*, rated 9 \/ 10/)).toBeTruthy();
  });

  it('removing asks first, keeps the viewings, and returns to "Add to your library"', async () => {
    const app = await open(
      shelf({}, (call) =>
        call.method === 'DELETE' ? new Response(null, { status: 204 }) : undefined,
      ),
    );
    await app.user.press(await screen.findByRole('button', { name: 'Remove from library' }));
    expect(screen.getByText('Remove this title? Your viewings are kept.')).toBeTruthy();
    await app.user.press(screen.getByRole('button', { name: 'Keep it' }));
    expect(screen.queryByText(/Your viewings are kept/)).toBeNull();
    await app.user.press(screen.getByRole('button', { name: 'Remove from library' }));
    await app.user.press(screen.getByRole('button', { name: 'Yes, remove it' }));
    expect(await screen.findByRole('header', { name: 'Add to your library' })).toBeTruthy();
    expect(app.calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
  });

  it('says so when a change is refused, and keeps what was there', async () => {
    const app = await open(
      shelf({}, (call) => (call.method === 'PATCH' ? problem(500, 'INTERNAL_ERROR') : undefined)),
    );
    await app.user.press(await screen.findByRole('radio', { name: '7' }));
    expect(await screen.findByText(/Something went wrong on our side/)).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Not rated' }).props.accessibilityState).toMatchObject(
      { checked: true },
    );
  });

  it('every control of the shelf is at least 44 points', async () => {
    await open(shelf());
    await screen.findByRole('header', { name: 'On your shelf' });
    const targets = [
      ...screen.queryAllByRole('button'),
      ...screen.queryAllByRole('radio'),
      ...screen.queryAllByRole('link'),
    ];
    expect(targets.length).toBeGreaterThan(10);
    for (const target of targets) {
      expect(Number(flatten(target.props.style)?.minHeight ?? 0)).toBeGreaterThanOrEqual(44);
    }
  });
});
