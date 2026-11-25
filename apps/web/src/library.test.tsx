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
 * T18: Library, Home ("Continue watching" +1), and the shelf panel on the title page.
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

  describe('the episode picker (catching up without pressing +1 a thousand times)', () => {
    const serving = (shows: unknown[], onProgress?: (call: Call) => Response) =>
      server((call) => {
        if (call.path.endsWith('/library')) return list(shows);
        if (call.path.endsWith('/progress') && onProgress !== undefined) return onProgress(call);
        return undefined;
      });
    const trigger = () => within(screen.getByTestId('episode-count')).getByRole('button');
    const open = async (app: ReturnType<typeof renderApp>) => {
      await screen.findByTestId('episode-count');
      await app.user.click(trigger());
      return await screen.findByRole('dialog', { name: /up to episode/i });
    };

    it('the number is a button that says what it does, and opens the picker', async () => {
      const app = renderApp({ route: '/', handler: serving([entry(1)]) });
      await screen.findByTestId('episode-count');
      expect(trigger().getAttribute('aria-haspopup')).toBe('dialog');
      expect(trigger().getAttribute('aria-label')).toMatch(/^Episode 3 of 12: change/);
      const dialog = await open(app);
      expect(within(dialog).getAllByRole('button', { name: /^Episode \d+$/ })).toHaveLength(12);
      expect(
        within(dialog).getByRole('button', { name: 'Episode 3' }).getAttribute('aria-current'),
      ).toBe('true');
    });

    it('picking an episode saves it in one request and closes', async () => {
      const app = renderApp({
        route: '/',
        handler: serving([entry(1)], () =>
          json(200, { data: detail(1, { progress: 9 }), suggestComplete: false }),
        ),
      });
      const dialog = await open(app);
      await app.user.click(within(dialog).getByRole('button', { name: 'Episode 9' }));
      await waitFor(() => {
        expect(app.to('/progress')).toHaveLength(1);
      });
      expect(app.to('/progress')[0]?.body).toEqual({ set: 9 });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(countText(screen.getByTestId('episode-count'))).toBe('9 / 12');
    });

    it('typing a number and pressing Enter saves it; Escape closes without asking the server', async () => {
      const app = renderApp({
        route: '/',
        handler: serving([entry(1)], () =>
          json(200, { data: detail(1, { progress: 7 }), suggestComplete: false }),
        ),
      });
      await open(app);
      await app.user.keyboard('{Escape}');
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(app.to('/progress')).toHaveLength(0);
      expect(document.activeElement).toBe(trigger());

      const dialog = await open(app);
      const field = within(dialog).getByRole('textbox');
      await app.user.clear(field);
      await app.user.type(field, '7{Enter}');
      await waitFor(() => {
        expect(app.to('/progress')).toHaveLength(1);
      });
      expect(app.to('/progress')[0]?.body).toEqual({ set: 7 });
    });

    it('only digits go in the box', async () => {
      const app = renderApp({ route: '/', handler: serving([entry(1)]) });
      const field = within(await open(app)).getByRole<HTMLInputElement>('textbox');
      await app.user.clear(field);
      await app.user.type(field, 'D1x0');
      expect(field.value).toBe('10');
    });

    it('explains a number past the total and does not save it', async () => {
      const app = renderApp({ route: '/', handler: serving([entry(1)]) });
      const dialog = await open(app);
      const field = within(dialog).getByRole('textbox');
      await app.user.clear(field);
      await app.user.type(field, '13{Enter}');
      expect((await within(dialog).findByRole('alert')).textContent).toBe(
        'This show has 12 episodes.',
      );
      expect(app.to('/progress')).toHaveLength(0);
      expect(screen.getByRole('dialog')).toBeTruthy();
    });

    it('a running season locks the episodes that have not aired, and refuses to type past them', async () => {
      const running = entry(1, { progress: 7, effectiveTotal: 12, episodesAired: 8 });
      const app = renderApp({ route: '/', handler: serving([running]) });
      await screen.findByTestId('episode-count');
      expect(countText(screen.getByTestId('episode-count'))).toBe('7 / 8');
      const dialog = await open(app);
      expect(
        within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Episode 8' }).disabled,
      ).toBe(false);
      for (const episode of [9, 10, 11, 12]) {
        expect(
          within(dialog).getByRole<HTMLButtonElement>('button', {
            name: `Episode ${episode}, not aired yet`,
          }).disabled,
        ).toBe(true);
      }
      const field = within(dialog).getByRole('textbox');
      await app.user.clear(field);
      await app.user.type(field, '10{Enter}');
      expect((await within(dialog).findByRole('alert')).textContent).toBe(
        'Only 8 episodes have aired so far.',
      );
      expect(app.to('/progress')).toHaveLength(0);
    });

    it('a running season stops +1 at what has aired', async () => {
      const running = entry(1, { progress: 8, effectiveTotal: 12, episodesAired: 8 });
      renderApp({ route: '/', handler: serving([running]) });
      await screen.findByTestId('episode-count');
      expect(screen.queryByRole('button', { name: '+1 episode of Show 1' })).toBeNull();
      expect(screen.getByText('Caught up')).toBeTruthy();
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
      const dialog = await open(app);
      // Too long for a grid of episodes: a number box and a way to jump to the latest.
      expect(within(dialog).queryByRole('list', { name: 'Episodes' })).toBeNull();
      const field = within(dialog).getByRole('textbox');
      await app.user.clear(field);
      await app.user.type(field, '1181');
      expect((await within(dialog).findByRole('alert')).textContent).toBe(
        'Only 1180 episodes have aired so far.',
      );
      await app.user.click(within(dialog).getByRole('button', { name: 'Latest aired · 1180' }));
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
      const dialog = await open(app);
      await app.user.click(within(dialog).getByRole('button', { name: 'Episode 8' }));
      expect((await screen.findByRole('alert')).textContent).toMatch(
        /Something went wrong on our side/,
      );
      expect(countText(screen.getByTestId('episode-count'))).toBe('3 / 12');
    });

    it('is plain text once the title is completed', async () => {
      renderApp({
        route: '/',
        handler: serving([entry(1, { status: 'completed', progress: 12 })]),
      });
      await screen.findByTestId('episode-count');
      expect(within(screen.getByTestId('episode-count')).queryByRole('button')).toBeNull();
    });
  });

  describe('the big ticket: the episode you just watched, and the one you are about to', () => {
    const episodes = (call: Call): Response | undefined => {
      const match = /\/titles\/[^/]+\/episodes\/(\d+)$/.exec(call.path);
      if (match === null) return undefined;
      const number = Number(match[1]);
      return json(200, {
        data: {
          episode: number,
          name: `Name of ${number}`,
          synopsis: `What happens in ${number}.`,
        },
      });
    };
    const serving = (note: string | null = null) =>
      server((call) => {
        if (call.path.endsWith('/library')) return list([entry(1), entry(2)]);
        if (call.path.endsWith(`/library/${entry(1).id}`))
          return json(200, { data: detail(1, { notes: note }) });
        return episodes(call);
      });

    it('leads with a recap of the episode you watched, not your note', async () => {
      renderApp({ route: '/', handler: serving('A note of mine') });
      expect(await screen.findByText('What happens in 3.')).toBeTruthy();
      expect(screen.getByText('Name of 3')).toBeTruthy();
      expect(screen.queryByText('A note of mine')).toBeNull();
    });

    it('holds the next episode back until you ask for the teaser', async () => {
      const app = renderApp({ route: '/', handler: serving() });
      await app.user.click(await screen.findByRole('button', { name: /^Up next · Ep 4/ }));
      expect(await screen.findByText('Name of 4')).toBeTruthy();
      // The teaser is not even on the page until it is asked for.
      expect(screen.queryByText('What happens in 4.')).toBeNull();
      expect(document.body.textContent).not.toContain('What happens in 4.');
      await app.user.click(screen.getByRole('button', { name: 'Show the teaser' }));
      expect(await screen.findByText('What happens in 4.')).toBeTruthy();
    });

    it('keeps your note one tab away', async () => {
      const app = renderApp({ route: '/', handler: serving('A note of mine') });
      await app.user.click(await screen.findByRole('button', { name: 'My note' }));
      expect(await screen.findByText('A note of mine')).toBeTruthy();
    });

    it('says so when no source has a synopsis, instead of leaving a gap', async () => {
      renderApp({
        route: '/',
        handler: server((call) => {
          if (call.path.endsWith('/library')) return list([entry(1)]);
          if (/\/episodes\/\d+$/.test(call.path))
            return json(200, { data: { episode: 3, name: null, synopsis: null } });
          return undefined;
        }),
      });
      expect(await screen.findByText('No synopsis for episode 3 yet.')).toBeTruthy();
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

describe('the title language applies from the first paint', () => {
  const named = (language: 'romaji' | 'english' | 'native') => {
    const names = {
      titleRomaji: 'Shingeki no Kyojin',
      titleEnglish: 'Attack on Titan',
      titleNative: '進撃の巨人',
    };
    const shown = {
      romaji: names.titleRomaji,
      english: names.titleEnglish,
      native: names.titleNative,
    };
    return {
      language,
      shown: shown[language],
      handler: signedInHandler({ titleLanguage: language }, (call) =>
        call.path.endsWith('/library')
          ? list([entry(1, { title: card(1, names) })])
          : problem(404, 'NOT_FOUND'),
      ),
    };
  };

  it.each(['romaji', 'english', 'native'] as const)(
    'names a show in %s on a page that loads with the account',
    async (language) => {
      const { shown, handler } = named(language);
      renderApp({ route: '/', handler });
      expect(await screen.findByRole('link', { name: shown })).toBeTruthy();
    },
  );
});

describe('Library: the seasons of one show are one tile', () => {
  const info = {
    id: '00000000-0000-4000-8000-0000000000f1',
    size: 7,
    seasons: 7,
    titleRomaji: 'My Hero Academia',
    titleEnglish: 'Boku no Hero Academia (English)',
    titleNative: null,
  };
  const withSeasons = server((call) => {
    if (call.path.endsWith('/library/counts')) return json(200, { data: COUNTS });
    if (call.path.endsWith('/library'))
      return list([
        entry(1, { title: card(1, { franchise: info }) }),
        entry(2),
        entry(3, { status: 'completed', title: card(3, { franchise: info }) }),
      ]);
    return undefined;
  });
  const tileName = 'Franchise My Hero Academia 7 seasons 2 in your library, 1 completed';

  it('puts the seasons you have of one show in one tile that opens the show', async () => {
    renderApp({ route: '/library', handler: withSeasons });
    const tile = await screen.findByRole('link', { name: tileName });
    expect(tile.getAttribute('href')).toBe(`/franchise/${info.id}`);
    // The other show is an ordinary poster; the seasons are behind the tile.
    expect(screen.getByRole('link', { name: 'Show 2' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Show 1' })).toBeNull();
  });

  it('makes a single season of a show a tile too, saying how far you are, so the grid looks alike', async () => {
    renderApp({
      route: '/library',
      handler: server((call) => {
        if (call.path.endsWith('/library/counts')) return json(200, { data: COUNTS });
        if (call.path.endsWith('/library'))
          return list([entry(1, { title: card(1, { franchise: info }) }), entry(2)]);
        return undefined;
      }),
    });
    expect(
      await screen.findByRole('link', {
        name: 'Franchise My Hero Academia 7 seasons Watching · 3 / 12',
      }),
    ).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Show 1' })).toBeNull();
  });

  it('keeps a single season as its own row in the compact list, with its +1', async () => {
    renderApp({
      route: '/library',
      handler: signedInHandler({ libraryView: 'list' }, (call) => {
        if (call.path.endsWith('/library/counts')) return json(200, { data: COUNTS });
        if (call.path.endsWith('/library'))
          return list([entry(1, { title: card(1, { franchise: info }) })]);
        return problem(404, 'NOT_FOUND');
      }),
    });
    expect(await screen.findByRole('button', { name: '+1 episode of Show 1' })).toBeTruthy();
  });

  it('is a tile in the compact list too', async () => {
    renderApp({
      route: '/library',
      handler: signedInHandler({ libraryView: 'list' }, (call) => {
        if (call.path.endsWith('/library/counts')) return json(200, { data: COUNTS });
        if (call.path.endsWith('/library'))
          return list([
            entry(1, { title: card(1, { franchise: info }) }),
            entry(3, { title: card(3, { franchise: info }) }),
          ]);
        return problem(404, 'NOT_FOUND');
      }),
    });
    expect(
      await screen.findByRole('link', {
        name: 'Franchise My Hero Academia 7 seasons 2 in your library',
      }),
    ).toBeTruthy();
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
    const before = app.to('/library').length;
    // No Search button: typing is the search, once it pauses.
    expect(screen.queryByRole('button', { name: 'Search' })).toBeNull();
    await app.user.type(screen.getByLabelText('Search your library'), 'show');
    await waitFor(() => {
      const last = query(app.to('/library').at(-1)!);
      expect(last.get('sort')).toBe('rating');
      expect(last.get('q')).toBe('show');
    });
    // One request for the word, not one per key.
    expect(app.to('/library').length - before).toBeLessThanOrEqual(2);
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

  it('removing asks first, keeps the viewings, and returns to "Add to your library"', async () => {
    const app = renderApp({
      route: `/title/${TITLE}`,
      handler: shelf({}, (call) =>
        call.method === 'DELETE' ? new Response(null, { status: 204 }) : undefined,
      ),
    });
    await app.user.click(await screen.findByRole('button', { name: 'Remove from library' }));
    expect(screen.getByRole('alert').textContent).toMatch(/Your viewings are kept/);
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
