import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { json, problem, renderApp, signedInHandler, violations, type Call } from './test/render';

/**
 * A show's page: its seasons (numbered, with their episodes), the movies and spin-offs, adding to the
 * library, marking where you are, and every episode opening on Crunchyroll.
 */

const FRANCHISE = '00000000-0000-4000-8000-0000000000f1';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const entryId = (n: number) => `00000000-aaaa-4000-8000-${String(n).padStart(12, '0')}`;

const card = (n: number, extra: Record<string, unknown> = {}) => ({
  id: id(n),
  kind: 'tv',
  titleRomaji: n === 4 ? 'The Movie' : `Season ${n}`,
  titleEnglish: null,
  titleNative: null,
  coverUrl: null,
  coverColor: null,
  crunchyrollUrl: null,
  streamingLinks: [],
  franchise: null,
  format: n === 4 ? 'MOVIE' : 'TV',
  status: 'finished',
  episodesTotal: n === 4 ? 1 : 5,
  season: 'spring',
  seasonYear: 2015 + n,
  averageScore: 80,
  libraryStatus: null,
  libraryEntryId: null,
  startDate: `${2015 + n}-04-01`,
  entry: null,
  ...extra,
});
const owned = (n: number, status: string, progress: number, extra: Record<string, unknown> = {}) =>
  card(n, {
    libraryStatus: status,
    libraryEntryId: entryId(n),
    entry: { progress, total: 5 },
    ...extra,
  });

const response = (titles: unknown[]) =>
  json(200, {
    data: {
      id: FRANCHISE,
      name: 'Season 1',
      titles,
      // Seasons 1 to 3 follow each other; the movie hangs off the side.
      relations: [
        { fromTitleId: id(1), toTitleId: id(2), relationType: 'sequel' },
        { fromTitleId: id(2), toTitleId: id(3), relationType: 'sequel' },
        { fromTitleId: id(1), toTitleId: id(4), relationType: 'side_story' },
      ],
      totals: { titles: 4, inLibrary: 0, completed: 0 },
    },
    meta: { stale: false, source: 'cache' },
  });

const detailOf = (n: number, extra: Record<string, unknown> = {}) =>
  json(200, {
    data: {
      ...card(n),
      synopsis: null,
      bannerUrl: null,
      durationMin: 24,
      endDate: null,
      popularity: 1,
      synonyms: [],
      genres: [],
      studios: [],
      nextAiring: null,
      franchiseId: FRANCHISE,
      crunchyrollEpisodes: {},
      ...extra,
    },
    meta: { stale: false, source: 'anilist' },
  });

const entryDetail = (n: number, status: string, progress: number) => ({
  id: entryId(n),
  title: card(n),
  status,
  progress,
  effectiveTotal: 5,
  totalOverridden: false,
  episodesAired: null,
  rating: null,
  isFavorite: false,
  alertsEnabled: null,
  startedAt: null,
  completedAt: null,
  addedAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-02T00:00:00.000Z',
  review: null,
  notes: null,
  runs: [],
});

const server = (titles: unknown[], extra: (call: Call) => Response | undefined = () => undefined) =>
  signedInHandler({}, (call) => {
    if (call.path.endsWith(`/franchises/${FRANCHISE}`)) return response(titles);
    return extra(call) ?? problem(404, 'NOT_FOUND');
  });

const fresh = () => [card(1), card(2), card(3), card(4)];

describe('The franchise page: a show you have not added', () => {
  it('lists the seasons numbered, then the movies and spin-offs, with how many of each', async () => {
    renderApp({ route: `/franchise/${FRANCHISE}`, handler: server(fresh()) });
    expect(await screen.findByRole('heading', { level: 1, name: 'Season 1' })).toBeTruthy();
    expect(screen.getByText('3 seasons · 1 movie, special or spin-off')).toBeTruthy();
    const seasons = screen.getByRole('region', { name: /^Seasons/ });
    expect(within(seasons).getAllByRole('article')).toHaveLength(3);
    expect(within(seasons).getByText('Season 3', { selector: 'p' })).toBeTruthy();
    const others = screen.getByRole('region', { name: /^Movies, specials and spin-offs/ });
    expect(within(others).getByRole('link', { name: 'The Movie' })).toBeTruthy();
  });

  it('adds every season in one go, in the chosen status', async () => {
    const app = renderApp({
      route: `/franchise/${FRANCHISE}`,
      handler: server(fresh(), (call) =>
        call.method === 'POST' && call.path.endsWith('/library')
          ? json(201, { data: entryDetail(1, 'watching', 0) })
          : undefined,
      ),
    });
    await app.user.selectOptions(await screen.findByLabelText('Add as'), 'watching');
    await app.user.click(screen.getByRole('button', { name: '+ Add all 3 seasons' }));
    await waitFor(() => {
      expect(app.to('/library').filter((call) => call.method === 'POST')).toHaveLength(3);
    });
    const posts = app.to('/library').filter((call) => call.method === 'POST');
    expect(posts.map((call) => (call.body as { titleId: string }).titleId)).toEqual([
      id(1),
      id(2),
      id(3),
    ]);
    expect(posts.every((call) => (call.body as { status: string }).status === 'watching')).toBe(
      true,
    );
  });

  it('adds one season on its own', async () => {
    const app = renderApp({
      route: `/franchise/${FRANCHISE}`,
      handler: server(fresh(), (call) =>
        call.method === 'POST' && call.path.endsWith('/library')
          ? json(201, { data: entryDetail(2, 'planned', 0) })
          : undefined,
      ),
    });
    await app.user.click(await screen.findByRole('button', { name: 'Add Season 2 as Planned' }));
    await waitFor(() => {
      expect(app.to('/library').filter((call) => call.method === 'POST')).toHaveLength(1);
    });
    expect(
      (app.to('/library').find((call) => call.method === 'POST')?.body as { titleId: string })
        .titleId,
    ).toBe(id(2));
    expect(await screen.findByText('Planned', { selector: 'span' })).toBeTruthy();
  });

  it('says so when the franchise does not exist', async () => {
    renderApp({
      route: `/franchise/${FRANCHISE}`,
      handler: signedInHandler({}, () => problem(404, 'NOT_FOUND')),
    });
    expect((await screen.findByRole('alert')).textContent).toMatch(/does not exist/);
  });
});

describe('The franchise page: where to watch', () => {
  it('lists the services that stream each season, each opening in a new tab', async () => {
    renderApp({
      route: `/franchise/${FRANCHISE}`,
      handler: server([
        card(1, {
          streamingLinks: [
            { site: 'Crunchyroll', url: 'https://www.crunchyroll.com/the-show' },
            { site: 'Netflix', url: 'https://www.netflix.com/title/1' },
          ],
        }),
        card(2),
        card(3),
        card(4),
      ]),
    });
    const first = (await screen.findAllByRole('article'))[0]!;
    const links = within(first).getAllByRole('link', { name: /opens in a new tab/ });
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      'https://www.crunchyroll.com/the-show',
      'https://www.netflix.com/title/1',
    ]);
    expect(links.every((link) => link.getAttribute('target') === '_blank')).toBe(true);
    expect(first.textContent).toMatch(/Watch on\s*Crunchyroll.*Netflix/);
  });

  it('fetches the services of a season stored before they were kept, when the page opens', async () => {
    const app = renderApp({
      route: `/franchise/${FRANCHISE}`,
      handler: server(fresh(), (call) =>
        call.path.endsWith(`/titles/${id(1)}`)
          ? detailOf(1, {
              streamingLinks: [{ site: 'Netflix', url: 'https://www.netflix.com/title/1' }],
            })
          : undefined,
      ),
    });
    expect(await screen.findByRole('link', { name: /Netflix/ })).toBeTruthy();
    expect(app.to(`/titles/${id(1)}`).length).toBeGreaterThan(0);
  });

  it('says nothing about where to watch a season no service lists', async () => {
    renderApp({ route: `/franchise/${FRANCHISE}`, handler: server(fresh()) });
    await screen.findByRole('heading', { level: 1, name: 'Season 1' });
    expect(screen.queryByText(/Watch on/)).toBeNull();
  });
});

describe('The franchise page: episodes and Crunchyroll', () => {
  const opening = async (
    n: number,
    titles: unknown[],
    detail: () => Response,
    extra?: (call: Call) => Response | undefined,
  ) => {
    const app = renderApp({
      route: `/franchise/${FRANCHISE}`,
      handler: server(titles, (call) =>
        call.path.endsWith(`/titles/${id(n)}`) ? detail() : extra?.(call),
      ),
    });
    await app.user.click(await screen.findByRole('button', { name: `Episodes of Season ${n}` }));
    return app;
  };

  it('opens a season to its episodes, each with a Watch link that opens in a new tab', async () => {
    const crunchyroll = { site: 'Crunchyroll', url: 'https://www.crunchyroll.com/the-show' };
    await opening(1, [card(1, { streamingLinks: [crunchyroll] }), card(2), card(3), card(4)], () =>
      detailOf(1, { streamingLinks: [crunchyroll] }),
    );
    const list = await screen.findByRole('list', { name: 'Episodes of Season 1' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
    const watch = within(list).getAllByRole('link', { name: /Crunchyroll/ });
    expect(watch).toHaveLength(5);
    for (const link of watch) {
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    }
  });

  it('links an episode to its own Crunchyroll page when AniList lists it, else to the show there', async () => {
    await opening(
      2,
      [
        card(1),
        card(2, {
          streamingLinks: [{ site: 'Crunchyroll', url: 'https://www.crunchyroll.com/the-show' }],
        }),
        card(3),
        card(4),
      ],
      () =>
        detailOf(2, {
          streamingLinks: [{ site: 'Crunchyroll', url: 'https://www.crunchyroll.com/the-show' }],
          crunchyrollEpisodes: { '2': 'https://www.crunchyroll.com/watch/GEP2/two' },
        }),
    );
    const list = await screen.findByRole('list', { name: 'Episodes of Season 2' });
    const href = (episode: number) =>
      within(list.querySelector(`[data-episode="${episode}"]`) as HTMLElement)
        .getByRole('link', { name: /Crunchyroll/ })
        .getAttribute('href');
    expect(href(2)).toBe('https://www.crunchyroll.com/watch/GEP2/two');
    expect(href(3)).toBe('https://www.crunchyroll.com/the-show');
  });

  describe('where to watch, on the services you have', () => {
    const NF = { site: 'Netflix', url: 'https://www.netflix.com/title/1' };
    const CR = { site: 'Crunchyroll', url: 'https://www.crunchyroll.com/the-show' };
    afterEach(() => {
      window.localStorage.clear();
    });

    it('a show on a service with no episode links opens its page there, and never a search', async () => {
      await opening(1, [card(1, { streamingLinks: [NF] }), card(2), card(3), card(4)], () =>
        detailOf(1, { streamingLinks: [NF] }),
      );
      const list = await screen.findByRole('list', { name: 'Episodes of Season 1' });
      const links = within(list).getAllByRole('link', { name: /Netflix/ });
      expect(links).toHaveLength(5);
      expect(links.every((link) => link.getAttribute('href') === NF.url)).toBe(true);
      expect(within(list).getAllByText(/show page/)).toHaveLength(5);
      expect(document.body.innerHTML).not.toContain('/search');
    });

    it('a show nobody lists gets no Watch control at all', async () => {
      await opening(1, [card(1), card(2), card(3), card(4)], () => detailOf(1));
      const list = await screen.findByRole('list', { name: 'Episodes of Season 1' });
      expect(within(list).queryByRole('link')).toBeNull();
      expect(within(list).queryByText(/Watch · /)).toBeNull();
    });

    it('with several services it is a menu: the episode on Crunchyroll first, then the show elsewhere', async () => {
      await opening(2, [card(1), card(2, { streamingLinks: [NF, CR] }), card(3), card(4)], () =>
        detailOf(2, {
          streamingLinks: [NF, CR],
          crunchyrollEpisodes: { '2': 'https://www.crunchyroll.com/watch/GEP2/two' },
        }),
      );
      const list = await screen.findByRole('list', { name: 'Episodes of Season 2' });
      const row = list.querySelector('[data-episode="2"]') as HTMLElement;
      expect(within(row).getByText('Watch · 2 services')).toBeTruthy();
      const items = within(row).getAllByRole('link');
      expect(items.map((link) => link.getAttribute('href'))).toEqual([
        'https://www.crunchyroll.com/watch/GEP2/two',
        NF.url,
      ]);
      expect(items[0]?.textContent).toMatch(/Opens this episode/);
      expect(items[1]?.textContent).toMatch(/Opens the show page/);
    });

    it('goes only to the services you chose in Settings', async () => {
      window.localStorage.setItem('akiba.services', JSON.stringify(['Netflix']));
      await opening(1, [card(1, { streamingLinks: [CR, NF] }), card(2), card(3), card(4)], () =>
        detailOf(1, { streamingLinks: [CR, NF] }),
      );
      const list = await screen.findByRole('list', { name: 'Episodes of Season 1' });
      const links = within(list).getAllByRole('link');
      expect(links).toHaveLength(5);
      expect(links.every((link) => link.getAttribute('href') === NF.url)).toBe(true);
    });
  });

  it('marks where you are: everything up to the episode counts as watched', async () => {
    const app = await opening(
      3,
      [owned(1, 'completed', 5), owned(2, 'completed', 5), owned(3, 'watching', 1), card(4)],
      () => detailOf(3),
      (call) =>
        call.path.endsWith('/progress')
          ? json(200, { data: entryDetail(3, 'watching', 4), suggestComplete: false })
          : undefined,
    );
    await app.user.click(
      await screen.findByRole('button', { name: 'Mark up to episode 4 as watched' }),
    );
    await waitFor(() => {
      expect(app.to('/progress')).toHaveLength(1);
    });
    expect(app.to('/progress')[0]?.body).toEqual({ set: 4 });
    expect(
      await screen.findByRole('button', { name: 'Watched up to episode 4: undo' }),
    ).toBeTruthy();
  });

  it('offers no marking for a season that is not in your library, only the links', async () => {
    await opening(1, fresh(), () => detailOf(1));
    await screen.findByRole('list', { name: 'Episodes of Season 1' });
    expect(screen.queryByRole('button', { name: /Mark up to episode/ })).toBeNull();
  });
});

describe('The franchise page: a show in your library', () => {
  const mine = () => [
    owned(1, 'completed', 5),
    owned(2, 'completed', 5),
    owned(3, 'watching', 2),
    card(4),
  ];

  it('shows how far you are, the status of each season, and what is next', async () => {
    renderApp({ route: `/franchise/${FRANCHISE}`, handler: server(mine()) });
    expect(await screen.findByText('Episode 3 is next')).toBeTruthy();
    expect(screen.getAllByText('Completed ✓')).toHaveLength(2);
    expect(screen.getByText('Watching · 2 / 5')).toBeTruthy();
    // Already in the library: no "add all".
    expect(screen.queryByRole('button', { name: /Add all/ })).toBeNull();
    const status = screen.getByRole('status', { name: '' });
    expect(status.textContent).toMatch(/3 of 3 seasons in your library/);
    expect(status.textContent).toMatch(/12 of 15 episodes watched/);
  });

  it('+1 on the continue ticket logs the next episode', async () => {
    const app = renderApp({
      route: `/franchise/${FRANCHISE}`,
      handler: server(mine(), (call) =>
        call.path.endsWith('/progress')
          ? json(200, { data: entryDetail(3, 'watching', 3), suggestComplete: false })
          : undefined,
      ),
    });
    await app.user.click(await screen.findByRole('button', { name: '+1 episode of Season 3' }));
    await waitFor(() => {
      expect(app.to('/progress')).toHaveLength(1);
    });
    expect(app.to('/progress')[0]?.body).toEqual({ set: 3 });
    // The count moves on the page without asking for the franchise again.
    expect(await screen.findByText('Episode 4 is next')).toBeTruthy();
  });

  it('has no axe violations (with a season open)', async () => {
    const app = renderApp({
      route: `/franchise/${FRANCHISE}`,
      handler: server(mine(), (call) =>
        call.path.endsWith(`/titles/${id(3)}`) ? detailOf(3) : undefined,
      ),
    });
    await app.user.click(await screen.findByRole('button', { name: 'Episodes of Season 3' }));
    await screen.findByRole('list', { name: 'Episodes of Season 3' });
    expect(await violations(app.container)).toEqual([]);
  });
});
