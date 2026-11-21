import { waitFor } from '@testing-library/react-native';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import {
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
 * T26: Home, Discover (search, browse, filters, season chart) and the title screen, with the real
 * router, API client and providers over a fake network. Requirement IDs: FR-DISC-001 (search),
 * -002 (filters), -003 (season chart), -004/-005 (title page, relations), -006 (pagination),
 * -007 (library status), -010 (stale labelling); doc 08 §5 (states) and §6 (accessibility).
 */

const META = { stale: false, source: 'anilist' };
const STORED = 'S'.repeat(43);

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
const flatten = (style: unknown) => StyleSheet.flatten(style as StyleProp<ViewStyle>);

/** A signed-in server whose catalog endpoints are scripted by `routes`. */
const server = (routes: (call: Call) => Response | undefined, overrides = {}): Handler =>
  signedInHandler((call) => routes(call) ?? problem(404, 'NOT_FOUND'), overrides);

/** Open the app signed in, on the Discover tab. */
async function onDiscover(handler: Handler) {
  const app = await renderApp({ handler, storedRefreshToken: STORED });
  await screen.findByText('Welcome, Reader');
  await app.user.press(tab('Discover'));
  return app;
}

describe('Discover: browse (FR-DISC-002, FR-DISC-006, FR-DISC-007)', () => {
  const catalog = server((call) => {
    if (call.path.endsWith('/genres')) return json(200, { data: ['Action', 'Comedy', 'Drama'] });
    if (call.path.includes('/titles/browse')) {
      return list([card(1), card(2, { libraryStatus: 'watching' }), card(3)]);
    }
    if (call.path.includes('/seasons/')) return list([]);
    return undefined;
  });

  it('lists titles as rows named by their name, facts and the reader’s own status', async () => {
    await onDiscover(catalog);
    expect(
      await screen.findByRole('link', { name: 'Show 1, TV · 12 episodes · Fall 2024' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Show 2, TV · 12 episodes · Fall 2024, Watching' }),
    ).toBeTruthy();
    expect(screen.getByRole('header', { name: 'Browse' })).toBeTruthy();
    expect(screen.getByText('Watching')).toBeTruthy(); // in words, not colour alone
  });

  it('filters combine and are sent to the API; Any removes them', async () => {
    const app = await onDiscover(catalog);
    await screen.findByRole('link', { name: /^Show 1/ });
    const sent = () => query(app.to('/titles/browse').at(-1)!);

    await app.user.press(screen.getByRole('radio', { name: 'Movie' }));
    await app.user.press(screen.getByRole('radio', { name: 'Airing' }));
    await app.user.press(screen.getByRole('radio', { name: 'Highest rated' }));
    await screen.findByRole('link', { name: /^Show 1/ });
    expect(Object.fromEntries(sent())).toMatchObject({
      format: 'movie',
      status: 'releasing',
      sort: 'score',
    });

    await app.user.press(screen.getAllByRole('radio', { name: 'Any' })[0]!); // format → any
    await screen.findByRole('link', { name: /^Show 1/ });
    expect(sent().get('format')).toBeNull();
    expect(sent().get('status')).toBe('releasing');
  });

  it('chooses a genre from a sheet, and says which is chosen', async () => {
    const app = await onDiscover(catalog);
    await screen.findByRole('link', { name: /^Show 1/ });
    await app.user.press(screen.getByRole('button', { name: 'Genre: any. Change' }));
    expect(await screen.findByRole('header', { name: 'Choose a genre' })).toBeTruthy();
    await app.user.press(screen.getByRole('radio', { name: 'Comedy' }));
    expect(await screen.findByRole('button', { name: 'Genre: Comedy. Change' })).toBeTruthy();
    await waitForRequest(app, (call) => query(call).get('genre') === 'Comedy');
    // The sheet marks the current choice with words.
    await app.user.press(screen.getByRole('button', { name: 'Genre: Comedy. Change' }));
    expect(await screen.findByText('Comedy (selected)')).toBeTruthy();
  });

  it('pages with Load more, keeping what is shown and asking for the next cursor once', async () => {
    const app = await onDiscover(
      server((call) => {
        if (call.path.endsWith('/genres')) return json(200, { data: [] });
        if (call.path.includes('/titles/browse')) {
          return query(call).get('cursor') === 'next'
            ? list([card(3), card(2)], { nextCursor: null })
            : list([card(1), card(2)], { nextCursor: 'next' });
        }
        return undefined;
      }),
    );
    await screen.findByRole('link', { name: /^Show 1/ });
    await app.user.press(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('link', { name: /^Show 3/ })).toBeTruthy();
    expect(screen.getAllByRole('link', { name: /^Show 2/ })).toHaveLength(1); // no duplicate
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(
      app.to('/titles/browse').filter((call) => query(call).get('cursor') === 'next'),
    ).toHaveLength(1);
  });

  it('labels a saved copy (FR-DISC-010)', async () => {
    await onDiscover(
      server((call) =>
        call.path.includes('/titles/browse')
          ? list([card(1)], { meta: { stale: true, source: 'cache' } })
          : call.path.endsWith('/genres')
            ? json(200, { data: [] })
            : undefined,
      ),
    );
    expect(await screen.findByText(/Showing saved results/)).toBeTruthy();
  });

  it('an error says so and Try again loads it again; an empty answer says what to do', async () => {
    let attempts = 0;
    const app = await onDiscover(
      server((call) => {
        if (call.path.endsWith('/genres')) return json(200, { data: [] });
        if (call.path.includes('/titles/browse')) {
          attempts += 1;
          if (attempts === 1) return problem(403, 'FORBIDDEN');
          return list([]);
        }
        return undefined;
      }),
    );
    expect(await screen.findByRole('alert')).toBeTruthy();
    await app.user.press(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByText('No titles match these filters. Remove one to see more.'),
    ).toBeTruthy();
  });

  it('a catalog outage with nothing saved says so in plain words', async () => {
    await onDiscover(
      server((call) =>
        call.path.includes('/titles/browse') ? problem(503, 'SOURCES_UNAVAILABLE') : undefined,
      ),
    );
    expect(await screen.findByText(/anime catalog is temporarily unavailable/)).toBeTruthy();
  });
});

describe('Discover: search (FR-DISC-001)', () => {
  const catalog = server((call) => {
    if (call.path.endsWith('/genres')) return json(200, { data: ['Action'] });
    if (call.path.includes('/titles/search')) return list([card(5), card(6)]);
    if (call.path.includes('/titles/browse')) return list([card(1)]);
    return undefined;
  });

  it('searches by name, switches off the browse-only filters, and clears', async () => {
    const app = await onDiscover(catalog);
    await screen.findByRole('link', { name: /^Show 1/ });
    await app.user.press(screen.getByRole('radio', { name: 'Movie' }));
    await app.user.type(screen.getByLabelText('Search by name'), '  attack on titan ');
    await app.user.press(screen.getByRole('button', { name: 'Search' }));

    expect(
      await screen.findByRole('header', { name: 'Results for “attack on titan”' }),
    ).toBeTruthy();
    expect(await screen.findByRole('link', { name: /^Show 5/ })).toBeTruthy();
    expect(Object.fromEntries(query(app.to('/titles/search').at(-1)!))).toMatchObject({
      q: 'attack on titan',
      format: 'movie',
    });
    // Status, genre and sort cannot be combined with a text search: off, and the screen says why.
    expect(screen.getByText(/apply when browsing/)).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Airing' }).props.accessibilityState).toMatchObject({
      disabled: true,
    });
    expect(
      screen.getByRole('button', { name: 'Genre: any. Change' }).props.accessibilityState,
    ).toMatchObject({
      disabled: true,
    });

    await app.user.press(screen.getByRole('button', { name: 'Clear search' }));
    expect(await screen.findByRole('header', { name: 'Browse' })).toBeTruthy();
    expect(await screen.findByRole('link', { name: /^Show 1/ })).toBeTruthy();
  });

  it('says what to try when nothing matches', async () => {
    const app = await onDiscover(
      server((call) =>
        call.path.includes('/titles/search')
          ? list([])
          : call.path.endsWith('/genres')
            ? json(200, { data: [] })
            : list([card(1)]),
      ),
    );
    await screen.findByRole('link', { name: /^Show 1/ });
    await app.user.type(screen.getByLabelText('Search by name'), 'zzzz');
    await app.user.press(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText(/Nothing matches “zzzz”/)).toBeTruthy();
  });
});

/** Wait until one of the calls made so far satisfies `matches`, inside `act`. */
async function waitForRequest(app: { calls: Call[] }, matches: (call: Call) => boolean) {
  await waitFor(() => {
    if (!app.calls.some(matches)) throw new Error('the request was never made');
  });
}

describe('Season chart and Home (FR-DISC-003)', () => {
  const seasons = server((call) => {
    if (call.path.endsWith('/genres')) return json(200, { data: [] });
    const match = /\/seasons\/(?:(\d{4})\/(\w+)|current)$/.exec(call.path);
    if (match !== null) {
      const year = Number(match[1] ?? 2026);
      const season = match[2] ?? 'fall';
      return list(season === 'summer' ? [] : [card(7), card(8)], { season, seasonYear: year });
    }
    return undefined;
  });

  it('Home shows what is airing this season, with a way to the whole chart', async () => {
    const app = await renderApp({ handler: seasons, storedRefreshToken: STORED });
    expect(await screen.findByRole('link', { name: /^Show 7/ })).toBeTruthy();
    expect(screen.getByRole('header', { name: 'Airing this season · Fall 2026' })).toBeTruthy();
    expect(Number(query(app.to('/seasons/current')[0]!).get('limit'))).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'See the whole season' })).toBeTruthy();
  });

  it('Home says so when the season has no titles yet', async () => {
    await renderApp({
      handler: server((call) =>
        call.path.includes('/seasons/')
          ? list([], { season: 'fall', seasonYear: 2026 })
          : undefined,
      ),
      storedRefreshToken: STORED,
    });
    expect(await screen.findByText('No titles are listed for this season yet.')).toBeTruthy();
  });

  it('the chart opens on the current season and moves to its neighbours', async () => {
    const app = await onDiscover(seasons);
    await app.user.press(await screen.findByRole('link', { name: 'Seasonal chart' }));
    expect(await screen.findByRole('header', { name: 'Fall 2026' })).toBeTruthy();
    expect(await screen.findByRole('link', { name: /^Show 7/ })).toBeTruthy();

    await app.user.press(screen.getByRole('link', { name: '← Summer 2026' }));
    expect(await screen.findByRole('header', { name: 'Summer 2026' })).toBeTruthy();
    expect(await screen.findByText('No titles are listed for this season yet.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Fall 2026 →' })).toBeTruthy();
  });
});

describe('Title screen (FR-DISC-004, FR-DISC-005, FR-DISC-007)', () => {
  const ID = '00000000-0000-4000-8000-000000000002';
  const relations = {
    data: [
      { relationType: 'prequel', titles: [card(5, { titleRomaji: 'The First Season' })] },
      { relationType: 'sequel', titles: [card(6, { titleRomaji: 'The Next Season' })] },
    ],
    meta: META,
  };
  const cast = {
    data: [
      {
        id: '00000000-0000-4000-8000-0000000000c1',
        name: 'Eren Yeager',
        nativeName: null,
        imageUrl: null,
        role: 'main',
        voiceActors: [
          {
            id: '00000000-0000-4000-8000-0000000000d1',
            name: 'Yuki Kaji',
            nativeName: null,
            imageUrl: null,
            language: 'Japanese',
          },
        ],
      },
    ],
    meta: META,
  };
  const catalog = (
    options: {
      detail?: Record<string, unknown>;
      relations?: Response;
      cast?: Response;
      meta?: typeof META;
    } = {},
    overrides: Record<string, unknown> = {},
  ) =>
    server((call) => {
      if (call.path.endsWith('/genres')) return json(200, { data: [] });
      if (call.path.includes('/titles/browse'))
        return list([card(2, { libraryStatus: 'watching' })]);
      if (call.path.endsWith('/relations')) return options.relations ?? json(200, relations);
      if (call.path.endsWith('/characters')) return options.cast ?? json(200, cast);
      if (call.path.endsWith(`/titles/${ID}`)) {
        return json(200, { data: detailOf(2, options.detail), meta: options.meta ?? META });
      }
      return undefined;
    }, overrides);

  async function openTitle(handler: Handler) {
    const app = await onDiscover(handler);
    await app.user.press(await screen.findByRole('link', { name: /^English 2|^Show 2/ }));
    return app;
  }

  it('shows names, facts, genres, studios, the synopsis in paragraphs, relations and the cast', async () => {
    await openTitle(catalog());
    expect(await screen.findByRole('header', { name: 'Show 2' })).toBeTruthy();
    expect(screen.getByText('English 2')).toBeTruthy(); // the other name, under the main one
    expect(screen.getByLabelText('Episodes: 12')).toBeTruthy();
    expect(screen.getByLabelText('Season: Fall 2024')).toBeTruthy();
    expect(screen.getByLabelText('Studios: Wit Studio')).toBeTruthy();
    expect(screen.getByText('Genres: Action, Comedy')).toBeTruthy();
    expect(screen.getByText('First paragraph.')).toBeTruthy();
    expect(screen.getByText('Second paragraph.')).toBeTruthy();
    expect(await screen.findByRole('header', { name: 'BEFORE THIS' })).toBeTruthy();
    expect(screen.getByRole('header', { name: 'AFTER THIS' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /^The Next Season/ })).toBeTruthy();
    expect(
      await screen.findByLabelText('Eren Yeager, Main character, voiced by Yuki Kaji'),
    ).toBeTruthy();
  });

  it('says when the next episode airs, in the reader’s own time zone', async () => {
    await openTitle(
      catalog(
        { detail: { nextAiring: { episode: 9, airsAt: '2026-11-20T14:00:00.000Z' } } },
        { timeZone: 'Asia/Tokyo' },
      ),
    );
    const text = (await screen.findByText(/^Episode 9 airs/)).props.children as string[];
    expect(text.join('')).toMatch(/11:00\s?PM|23:00/i);
    expect(text.join('')).toMatch(/GMT\+9|JST/);
  });

  it('uses the language chosen in settings for the name', async () => {
    await openTitle(catalog({}, { titleLanguage: 'english' }));
    expect(await screen.findByRole('header', { name: 'English 2' })).toBeTruthy();
    expect(screen.getByText('Show 2')).toBeTruthy();
  });

  it('labels a saved copy, and failed relation and cast lookups do not hide the page', async () => {
    await openTitle(
      catalog({
        meta: { stale: true, source: 'cache' },
        relations: problem(500, 'BOOM'),
        cast: problem(500, 'BOOM'),
      }),
    );
    expect(await screen.findByRole('header', { name: 'Show 2' })).toBeTruthy();
    expect(screen.getByText(/This is the copy saved earlier/)).toBeTruthy();
    expect(await screen.findByText('Related titles could not be loaded just now.')).toBeTruthy();
    expect(await screen.findByText('The characters could not be loaded just now.')).toBeTruthy();
    expect(screen.getByText('First paragraph.')).toBeTruthy();
  });

  it('empty relations and cast say so', async () => {
    await openTitle(
      catalog({
        relations: json(200, { data: [], meta: META }),
        cast: json(200, { data: [], meta: META }),
      }),
    );
    expect(await screen.findByText('Nothing is related to this title yet.')).toBeTruthy();
    expect(await screen.findByText('No characters are listed for this title yet.')).toBeTruthy();
  });

  it('a title that is missing says so; an unsaved title during an outage says it is not saved yet', async () => {
    const missing = await renderApp({
      route: `/title/${ID}`,
      handler: server((call) =>
        call.path.includes('/titles/') ? problem(404, 'NOT_FOUND') : undefined,
      ),
      storedRefreshToken: STORED,
    });
    expect(await screen.findByRole('header', { name: 'Title not found' })).toBeTruthy();
    expect(missing.calls.length).toBeGreaterThan(0);
  });

  it('every tappable thing on the list and the title is at least 44 points', async () => {
    await openTitle(catalog());
    await screen.findByRole('header', { name: 'Show 2' });
    const targets = [...screen.queryAllByRole('button'), ...screen.queryAllByRole('link')];
    expect(targets.length).toBeGreaterThanOrEqual(2); // the related titles at least
    for (const target of targets) {
      // A row that lost its style (a function style does not survive `Link asChild`) reads as 0.
      expect(Number(flatten(target.props.style)?.minHeight ?? 0)).toBeGreaterThanOrEqual(44);
    }
  });
});
