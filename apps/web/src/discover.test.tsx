import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  USER,
  json,
  problem,
  renderApp,
  signedInHandler,
  violations,
  type Call,
} from './test/render';

/**
 * T13: Discover, the seasonal chart and the title page, with the real API client over a fake
 * network. Requirement IDs: FR-DISC-001 (search), -002 (filters), -003 (season chart), -004/-005
 * (title page, relations), -006 (pagination), -007 (library status), -010 (stale labelling);
 * doc 08 §5 (states) and §6 (accessibility).
 */

const META = { stale: false, source: 'anilist' };

const card = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  kind: 'tv',
  titleRomaji: `Show ${n}`,
  titleEnglish: n % 2 === 0 ? `English ${n}` : null,
  titleNative: null,
  coverUrl: n === 1 ? null : `https://img.example.test/${n}.jpg`,
  format: 'TV',
  status: 'finished',
  episodesTotal: 12,
  season: 'fall',
  seasonYear: 2024,
  averageScore: 80,
  libraryStatus: null,
  libraryEntryId: null,
  ...extra,
});

const list = (cards: unknown[], extra: Record<string, unknown> = {}) =>
  json(200, { data: cards, nextCursor: null, meta: META, ...extra });

const detailOf = (n: number, extra: Record<string, unknown> = {}) => ({
  ...card(n),
  synopsis: 'First paragraph.\n\nSecond paragraph.',
  bannerUrl: null,
  durationMin: 24,
  startDate: '2024-10-05',
  endDate: null,
  popularity: 10,
  synonyms: [],
  genres: ['Action', 'Comedy'],
  studios: [{ id: '00000000-0000-4000-8000-0000000000aa', name: 'Wit Studio', isMain: true }],
  nextAiring: null,
  franchiseId: null,
  ...extra,
});

const query = (call: Call): URLSearchParams => new URLSearchParams(call.search);

/** A signed-in server whose catalog endpoints are scripted by `routes`. */
function server(routes: (call: Call) => Response | undefined) {
  return signedInHandler({}, (call) => routes(call) ?? problem(404, 'NOT_FOUND'));
}

describe('Discover: browse (FR-DISC-002, FR-DISC-006)', () => {
  const catalog = server((call) => {
    if (call.path.endsWith('/genres')) return json(200, { data: ['Action', 'Comedy', 'Drama'] });
    if (call.path.includes('/titles/browse')) return list([card(1), card(2), card(3)]);
    return undefined;
  });

  it('shows a skeleton, then poster cards with the name, facts and a typographic stand-in for a missing cover', async () => {
    const app = renderApp({ route: '/discover', handler: catalog });
    expect(await screen.findByRole('status', { name: 'Loading titles' })).toBeTruthy();
    const grid = await screen.findByRole('list', { name: 'Titles' });
    const articles = within(grid).getAllByRole('article');
    expect(articles).toHaveLength(3);
    // The name is one link per card (stretched link): the card's accessible entry point.
    const link = within(articles[0]!).getByRole('link', { name: 'Show 1' });
    expect(link.getAttribute('href')).toBe('/title/00000000-0000-4000-8000-000000000001');
    expect(within(articles[0]!).getByText('TV · 12 episodes · Fall 2024')).toBeTruthy();
    // No cover: the name is set in type on the placeholder, so nothing is empty.
    expect(within(articles[0]!).getAllByText('Show 1').length).toBeGreaterThanOrEqual(2);
    // Covers are decorative next to the name.
    expect(articles[1]!.querySelector('img')?.getAttribute('alt')).toBe('');
    expect(app.to('/titles/browse').length).toBeGreaterThanOrEqual(1);
  });

  it('sends combined filters to the API (format + status + genre + sort)', async () => {
    const app = renderApp({ route: '/discover', handler: catalog });
    await screen.findByRole('list', { name: 'Titles' });
    await screen.findByRole('option', { name: 'Drama' });
    await app.user.selectOptions(screen.getByLabelText('Format'), 'tv');
    await app.user.selectOptions(screen.getByLabelText('Status'), 'finished');
    await app.user.selectOptions(screen.getByLabelText('Genre'), 'Comedy');
    await app.user.selectOptions(screen.getByLabelText('Sort by'), 'score');
    await waitFor(() => {
      const last = app.to('/titles/browse').at(-1);
      expect(Object.fromEntries(query(last!))).toMatchObject({
        format: 'tv',
        status: 'finished',
        genre: 'Comedy',
        sort: 'score',
        limit: '24',
      });
    });
  });

  it('says what to do when nothing matches (one sentence)', async () => {
    renderApp({
      route: '/discover?genre=Drama',
      handler: server((call) =>
        call.path.includes('/titles/browse') ? list([]) : json(200, { data: [] }),
      ),
    });
    expect(
      await screen.findByText('No titles match these filters. Remove one to see more.'),
    ).toBeTruthy();
  });

  it('keeps the state in the address: a reload with filters in the URL applies them', async () => {
    const app = renderApp({ route: '/discover?format=movie&sort=start_date', handler: catalog });
    await screen.findByRole('list', { name: 'Titles' });
    expect(Object.fromEntries(query(app.to('/titles/browse')[0]!))).toMatchObject({
      format: 'movie',
      sort: 'start_date',
    });
    expect(screen.getByLabelText<HTMLSelectElement>('Format').value).toBe('movie');
  });

  it('ignores a filter value it does not know instead of sending it', async () => {
    const app = renderApp({ route: '/discover?format=film&sort=chaos', handler: catalog });
    await screen.findByRole('list', { name: 'Titles' });
    const sent = Object.fromEntries(query(app.to('/titles/browse')[0]!));
    expect(sent).not.toHaveProperty('format');
    expect(sent).not.toHaveProperty('sort');
  });

  it('pages with "Load more" and never shows a title twice', async () => {
    const app = renderApp({
      route: '/discover',
      handler: server((call) => {
        if (call.path.endsWith('/genres')) return json(200, { data: [] });
        if (!call.path.includes('/titles/browse')) return undefined;
        return query(call).get('cursor') === null
          ? list([card(1), card(2)], { nextCursor: 'next' })
          : list([card(2), card(3)]); // 2 again: the source's pages can overlap
      }),
    });
    await screen.findByRole('list', { name: 'Titles' });
    await app.user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => {
      expect(
        within(screen.getByRole('list', { name: 'Titles' })).getAllByRole('article'),
      ).toHaveLength(3);
    });
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(query(app.to('/titles/browse').at(-1)!).get('cursor')).toBe('next');
  });

  it('keeps what is shown when "Load more" fails, and says so', async () => {
    const app = renderApp({
      route: '/discover',
      handler: server((call) => {
        if (call.path.endsWith('/genres')) return json(200, { data: [] });
        if (!call.path.includes('/titles/browse')) return undefined;
        return query(call).get('cursor') === null
          ? list([card(1)], { nextCursor: 'next' })
          : problem(500, 'INTERNAL_ERROR');
      }),
    });
    await screen.findByRole('list', { name: 'Titles' });
    await app.user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText(/Something went wrong on our side/)).toBeTruthy();
    expect(
      within(screen.getByRole('list', { name: 'Titles' })).getAllByRole('article'),
    ).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy(); // can try again
  });

  it('labels saved results as saved when the catalog is unreachable (FR-DISC-010)', async () => {
    renderApp({
      route: '/discover',
      handler: server((call) =>
        call.path.includes('/titles/browse')
          ? list([card(1)], { meta: { stale: true, source: 'cache' } })
          : json(200, { data: [] }),
      ),
    });
    expect(await screen.findByText(/Showing saved results/)).toBeTruthy();
  });

  it("shows the user's own status on the card in words (FR-DISC-007)", async () => {
    renderApp({
      route: '/discover',
      handler: server((call) =>
        call.path.includes('/titles/browse')
          ? list([card(1, { libraryStatus: 'on_hold' })])
          : json(200, { data: [] }),
      ),
    });
    expect(await screen.findByText('On hold')).toBeTruthy();
  });

  it('reports a catalog outage plainly and lets the user retry', async () => {
    let healthy = false;
    const app = renderApp({
      route: '/discover',
      handler: server((call) => {
        if (call.path.endsWith('/genres')) return json(200, { data: [] });
        if (!call.path.includes('/titles/browse')) return undefined;
        return healthy ? list([card(1)]) : problem(503, 'SOURCES_UNAVAILABLE');
      }),
    });
    expect((await screen.findByRole('alert')).textContent).toMatch(/temporarily unavailable/);
    healthy = true;
    await app.user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('list', { name: 'Titles' })).toBeTruthy();
  });

  it('is free of automatically detectable accessibility problems', async () => {
    const app = renderApp({ route: '/discover', handler: catalog });
    await screen.findByRole('list', { name: 'Titles' });
    expect(await violations(app.container)).toEqual([]);
  });
});

describe('Discover: the seasons of one show are one tile', () => {
  const FRANCHISE = '00000000-0000-4000-8000-0000000000f1';
  const info = {
    id: FRANCHISE,
    size: 4,
    seasons: 3,
    titleRomaji: 'My Hero Academia',
    titleEnglish: 'Boku no Hero Academia (English)',
    titleNative: null,
  };
  const seasons = [10, 11, 12].map((n) => card(n, { franchise: info, seasonYear: 2016 + n - 10 }));
  const catalog = server((call) => {
    if (call.path.endsWith('/genres')) return json(200, { data: [] });
    if (call.path.includes('/titles/search')) return list([...seasons, card(20)]);
    return undefined;
  });
  const tileName = 'Franchise My Hero Academia 3 seasons · 1 movie, special or spin-off';

  it('shows the seasons as one tile named after the first, not one card each', async () => {
    renderApp({ route: '/discover?q=hero', handler: catalog });
    const tile = await screen.findByRole('link', { name: tileName });
    expect(tile.getAttribute('href')).toBe(`/franchise/${FRANCHISE}`);
    // The seasons are behind it, not beside it: only the other show is a card of its own.
    expect(screen.queryByRole('link', { name: 'Show 10' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Show 20' })).toBeTruthy();
  });

  it('is a plain link: nothing expands, and no season is fetched until the page is opened', async () => {
    const app = renderApp({ route: '/discover?q=hero', handler: catalog });
    await screen.findByRole('link', { name: tileName });
    expect(app.to('/franchises/').length).toBe(0);
    expect(screen.queryByRole('button', { name: /My Hero Academia/ })).toBeNull();
  });

  it('says how many of it you have in your library', async () => {
    renderApp({
      route: '/discover?q=hero',
      handler: server((call) => {
        if (call.path.endsWith('/genres')) return json(200, { data: [] });
        if (call.path.includes('/titles/search')) {
          return list([
            card(10, {
              franchise: info,
              libraryStatus: 'completed',
              libraryEntryId: '00000000-aaaa-4000-8000-0000000000e1',
            }),
            card(11, { franchise: info }),
          ]);
        }
        return undefined;
      }),
    });
    expect(await screen.findByRole('link', { name: `${tileName} 1 in your library` })).toBeTruthy();
  });

  it('keeps a title whose franchise has only itself on the page as an ordinary card', async () => {
    renderApp({
      route: '/discover?q=hero',
      handler: server((call) => {
        if (call.path.endsWith('/genres')) return json(200, { data: [] });
        if (call.path.includes('/titles/search')) {
          return list([card(10, { franchise: info }), card(20)]);
        }
        return undefined;
      }),
    });
    expect(await screen.findByRole('link', { name: 'Show 10' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /^Franchise / })).toBeNull();
  });

  it('has no axe violations', async () => {
    const app = renderApp({ route: '/discover?q=hero', handler: catalog });
    await screen.findByRole('link', { name: tileName });
    expect(await violations(app.container)).toEqual([]);
  });
});

describe('Discover: search (FR-DISC-001)', () => {
  const catalog = server((call) => {
    if (call.path.endsWith('/genres')) return json(200, { data: ['Action'] });
    if (call.path.includes('/titles/search')) return list([card(1), card(2)]);
    if (call.path.includes('/titles/browse')) return list([card(3)]);
    return undefined;
  });

  it('searches on submit, shows the query in the heading and puts it in the URL', async () => {
    const app = renderApp({ route: '/discover', handler: catalog });
    await screen.findByRole('list', { name: 'Titles' });
    await app.user.type(screen.getByLabelText('Search by name'), 'attack on titan{enter}');
    expect(
      await screen.findByRole('heading', { name: 'Results for “attack on titan”' }),
    ).toBeTruthy();
    expect(query(app.to('/titles/search')[0]!).get('q')).toBe('attack on titan');
    expect(await screen.findByRole('list', { name: 'Search results' })).toBeTruthy();
  });

  it('searches as you type: once typing pauses, with no Enter, and not for every letter', async () => {
    const app = renderApp({ route: '/discover', handler: catalog });
    await screen.findByRole('list', { name: 'Titles' });
    await app.user.type(screen.getByLabelText('Search by name'), 'naruto');
    expect(await screen.findByRole('heading', { name: 'Results for “naruto”' })).toBeTruthy();
    expect(await screen.findByRole('list', { name: 'Search results' })).toBeTruthy();
    expect(app.to('/titles/search').map((call) => query(call).get('q'))).toEqual(['naruto']);
  });

  it('does not take away a space you just typed, so a second word can follow', async () => {
    const app = renderApp({ route: '/discover', handler: catalog });
    await screen.findByRole('list', { name: 'Titles' });
    const box = screen.getByLabelText<HTMLInputElement>('Search by name');
    await app.user.type(box, 'my hero ');
    await screen.findByRole('heading', { name: 'Results for “my hero”' });
    expect(box.value).toBe('my hero ');
    await app.user.type(box, 'academia');
    await screen.findByRole('heading', { name: 'Results for “my hero academia”' });
    expect(box.value).toBe('my hero academia');
  });

  it('emptying the box returns to browsing', async () => {
    const app = renderApp({ route: '/discover?q=attack', handler: catalog });
    await screen.findByRole('list', { name: 'Search results' });
    await app.user.clear(screen.getByLabelText('Search by name'));
    expect(await screen.findByRole('heading', { name: 'Browse' })).toBeTruthy();
    expect(await screen.findByRole('list', { name: 'Titles' })).toBeTruthy();
  });

  it('turns off the filters search cannot use, and says why', async () => {
    renderApp({ route: '/discover?q=attack', handler: catalog });
    await screen.findByRole('list', { name: 'Search results' });
    expect(screen.getByLabelText<HTMLSelectElement>('Genre').disabled).toBe(true);
    expect(screen.getByLabelText<HTMLSelectElement>('Status').disabled).toBe(true);
    expect(screen.getByLabelText<HTMLSelectElement>('Format').disabled).toBe(false);
    expect(screen.getByText(/apply when browsing/)).toBeTruthy();
  });

  it('"Clear search" returns to browsing', async () => {
    const app = renderApp({ route: '/discover?q=attack', handler: catalog });
    await screen.findByRole('list', { name: 'Search results' });
    await app.user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(await screen.findByRole('heading', { name: 'Browse' })).toBeTruthy();
  });

  it('says so when a search finds nothing', async () => {
    renderApp({
      route: '/discover?q=zzzz',
      handler: server((call) =>
        call.path.includes('/titles/search') ? list([]) : json(200, { data: [] }),
      ),
    });
    expect(await screen.findByText(/Nothing matches “zzzz”/)).toBeTruthy();
  });

  it('a slow old search can never overwrite a newer one', async () => {
    let releaseSlow: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const app = renderApp({
      route: '/discover?q=old',
      handler: async (call) => {
        if (call.path.endsWith('/auth/refresh'))
          return json(200, { accessToken: 'a', tokenType: 'Bearer', expiresIn: 900 });
        if (call.path.endsWith('/me')) return json(200, USER);
        if (call.path.endsWith('/genres')) return json(200, { data: [] });
        if (call.path.includes('/titles/search')) {
          if (query(call).get('q') === 'old') {
            await slow;
            return list([card(7, { titleRomaji: 'Old Result' })]);
          }
          return list([card(8, { titleRomaji: 'New Result' })]);
        }
        return problem(404, 'NOT_FOUND');
      },
    });
    const box = await screen.findByLabelText('Search by name');
    await app.user.clear(box);
    await app.user.type(box, 'new{enter}');
    expect(await screen.findByText('New Result')).toBeTruthy();
    releaseSlow();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByText('Old Result')).toBeNull();
    expect(screen.getByText('New Result')).toBeTruthy();
  });
});

describe('Seasonal chart (FR-DISC-003)', () => {
  const catalog = server((call) =>
    call.path.includes('/seasons/')
      ? list([card(1), card(2)], {
          season: call.path.split('/').at(-1),
          seasonYear: Number(call.path.split('/').at(-2)),
        })
      : undefined,
  );

  it('shows a season with links to the seasons either side', async () => {
    const app = renderApp({ route: '/discover/season/2024/fall', handler: catalog });
    expect(await screen.findByRole('heading', { level: 1, name: 'Fall 2024' })).toBeTruthy();
    await screen.findByRole('list', { name: 'Fall 2024 titles' });
    const nav = screen.getByRole('navigation', { name: 'Seasons' });
    expect(within(nav).getByRole('link', { name: '← Summer 2024' }).getAttribute('href')).toBe(
      '/discover/season/2024/summer',
    );
    expect(within(nav).getByRole('link', { name: 'Winter 2025 →' }).getAttribute('href')).toBe(
      '/discover/season/2025/winter',
    );
    expect(app.to('/seasons/2024/fall').length).toBeGreaterThanOrEqual(1);
  });

  it('moves across a year boundary', async () => {
    renderApp({ route: '/discover/season/2024/winter', handler: catalog });
    const nav = await screen.findByRole('navigation', { name: 'Seasons' });
    expect(within(nav).getByRole('link', { name: '← Fall 2023' })).toBeTruthy();
  });

  it('sends an address that is not a season to the current one', async () => {
    renderApp({ route: '/discover/season/2024/autumn', handler: catalog });
    expect(
      await screen.findByRole('heading', { level: 1, name: /^(Winter|Spring|Summer|Fall) \d{4}$/ }),
    ).toBeTruthy();
  });

  it('is free of automatically detectable accessibility problems', async () => {
    const app = renderApp({ route: '/discover/season/2024/fall', handler: catalog });
    await screen.findByRole('list', { name: 'Fall 2024 titles' });
    expect(await violations(app.container)).toEqual([]);
  });
});

describe('Title page (FR-DISC-004, FR-DISC-005, FR-DISC-007)', () => {
  const ID = '00000000-0000-4000-8000-000000000002';
  const catalog = (detail: Record<string, unknown> = {}, meta = META) =>
    server((call) => {
      if (call.path.endsWith('/relations')) {
        return json(200, {
          data: [
            { relationType: 'prequel', titles: [card(5, { titleRomaji: 'The First Season' })] },
            { relationType: 'sequel', titles: [card(6, { titleRomaji: 'The Next Season' })] },
          ],
          meta,
        });
      }
      if (call.path.endsWith(ID)) return json(200, { data: detailOf(2, detail), meta });
      return undefined;
    });

  it('shows names, facts, genres, synopsis in paragraphs and the related titles', async () => {
    const app = renderApp({ route: `/title/${ID}`, handler: catalog() });
    expect(await screen.findByRole('heading', { level: 1, name: 'Show 2' })).toBeTruthy();
    expect(screen.getByText('English 2')).toBeTruthy();
    expect(screen.getByText('Wit Studio')).toBeTruthy();
    const genres = screen.getByRole('list', { name: 'Genres' });
    expect(
      within(genres)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Action', 'Comedy']);
    expect(screen.getByText('First paragraph.')).toBeTruthy();
    expect(screen.getByText('Second paragraph.')).toBeTruthy();
    // Facts as a definition list (term + value pairs).
    expect(screen.getByText('Episodes').nextElementSibling?.textContent).toBe('12');
    expect(screen.getByText('Season').nextElementSibling?.textContent).toBe('Fall 2024');
    // Related titles, grouped, each a card linking to its own page.
    expect(await screen.findByRole('heading', { level: 3, name: 'Before this' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'After this' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'The Next Season' }).getAttribute('href')).toBe(
      '/title/00000000-0000-4000-8000-000000000006',
    );
    expect(app.to(ID).length).toBeGreaterThanOrEqual(1);
  });

  it('shows when the next episode airs', async () => {
    renderApp({
      route: `/title/${ID}`,
      handler: catalog({
        libraryStatus: 'watching',
        nextAiring: { episode: 8, airsAt: '2026-11-20T15:00:00.000Z' },
      }),
    });
    // The shelf itself (status, +1, rating…) is covered in library.test.tsx.
    expect(await screen.findByRole('heading', { name: 'Show 2' })).toBeTruthy();
    const airing = screen.getByText(/Episode 8 airs/);
    expect(airing.querySelector('time')?.getAttribute('datetime')).toBe('2026-11-20T15:00:00.000Z');
  });

  it('labels a saved copy (FR-DISC-010)', async () => {
    renderApp({ route: `/title/${ID}`, handler: catalog({}, { stale: true, source: 'cache' }) });
    expect(await screen.findByText(/This is the copy saved earlier/)).toBeTruthy();
  });

  it('a failed relation lookup does not hide the page', async () => {
    renderApp({
      route: `/title/${ID}`,
      handler: server((call) => {
        if (call.path.endsWith('/relations')) return problem(503, 'SOURCES_UNAVAILABLE');
        if (call.path.endsWith(ID)) return json(200, { data: detailOf(2), meta: META });
        return undefined;
      }),
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Show 2' })).toBeTruthy();
    expect(await screen.findByText('Related titles could not be loaded just now.')).toBeTruthy();
  });

  it('says a missing title is missing, and links back', async () => {
    renderApp({ route: `/title/${ID}`, handler: server(() => problem(404, 'NOT_FOUND')) });
    expect(await screen.findByRole('heading', { name: 'Title not found' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to Discover' })).toBeTruthy();
  });

  it('explains a title that was never saved and cannot be fetched', async () => {
    renderApp({
      route: `/title/${ID}`,
      handler: server(() => problem(503, 'SOURCES_UNAVAILABLE')),
    });
    expect((await screen.findByRole('alert')).textContent).toMatch(/has not been saved yet/);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('sets the page title to the name of the title', async () => {
    renderApp({ route: `/title/${ID}`, handler: catalog() });
    await screen.findByRole('heading', { level: 1, name: 'Show 2' });
    await waitFor(() => {
      expect(document.title).toBe('Show 2 · Akiba');
    });
  });

  it('is free of automatically detectable accessibility problems', async () => {
    const app = renderApp({ route: `/title/${ID}`, handler: catalog() });
    await screen.findByRole('heading', { level: 3, name: 'Before this' });
    expect(await violations(app.container)).toEqual([]);
  });
});

describe('navigation', () => {
  it('lists Discover in the main navigation and marks it when current', async () => {
    renderApp({
      route: '/discover',
      handler: server((call) =>
        call.path.includes('/titles/browse') ? list([]) : json(200, { data: [] }),
      ),
    });
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Discover' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });
});
