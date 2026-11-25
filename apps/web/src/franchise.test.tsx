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

  describe('Watch: only a link that opens the episode itself', () => {
    const NF = { site: 'Netflix', url: 'https://www.netflix.com/title/1' };
    const CR = { site: 'Crunchyroll', url: 'https://www.crunchyroll.com/the-show' };
    const EP2 = 'https://www.crunchyroll.com/watch/GEP2/two';
    afterEach(() => {
      window.localStorage.clear();
    });

    it('has a Watch link on the episodes AniList lists, opening that episode in a new tab, and none on the others', async () => {
      await opening(2, [card(1), card(2, { streamingLinks: [CR] }), card(3), card(4)], () =>
        detailOf(2, { streamingLinks: [CR], crunchyrollEpisodes: { '2': EP2 } }),
      );
      const list = await screen.findByRole('list', { name: 'Episodes of Season 2' });
      const links = within(list).getAllByRole('link');
      expect(links).toHaveLength(1);
      expect(links[0]?.getAttribute('href')).toBe(EP2);
      expect(links[0]?.getAttribute('target')).toBe('_blank');
      expect(links[0]?.getAttribute('rel')).toBe('noopener noreferrer');
      expect(
        within(list.querySelector('[data-episode="2"]') as HTMLElement).getByRole('link'),
      ).toBe(links[0]);
      expect(
        within(list.querySelector('[data-episode="3"]') as HTMLElement).queryByRole('link'),
      ).toBeNull();
    });

    it('never sends an episode to the show page or a search: a show with no episode links has no Watch button', async () => {
      await opening(1, [card(1, { streamingLinks: [CR, NF] }), card(2), card(3), card(4)], () =>
        detailOf(1, { streamingLinks: [CR, NF] }),
      );
      const list = await screen.findByRole('list', { name: 'Episodes of Season 1' });
      expect(within(list).queryByRole('link')).toBeNull();
      expect(within(list).queryByText(/Watch/)).toBeNull();
      expect(document.body.innerHTML).not.toContain('/search');
      // The season row still says which services have the show.
      expect(screen.getAllByRole('link', { name: /Netflix/ }).length).toBeGreaterThan(0);
    });

    it('a show nobody lists gets no Watch control at all', async () => {
      await opening(1, [card(1), card(2), card(3), card(4)], () => detailOf(1));
      const list = await screen.findByRole('list', { name: 'Episodes of Season 1' });
      expect(within(list).queryByRole('link')).toBeNull();
    });

    it('follows the services you picked: without Crunchyroll there is no episode link, and the season lists only yours', async () => {
      window.localStorage.setItem('akiba.services', JSON.stringify(['Netflix']));
      await opening(2, [card(1), card(2, { streamingLinks: [CR, NF] }), card(3), card(4)], () =>
        detailOf(2, { streamingLinks: [CR, NF], crunchyrollEpisodes: { '2': EP2 } }),
      );
      const list = await screen.findByRole('list', { name: 'Episodes of Season 2' });
      expect(within(list).queryByRole('link')).toBeNull();
      const row = screen.getAllByRole('article')[1]!;
      expect(within(row).queryByRole('link', { name: /Crunchyroll/ })).toBeNull();
      expect(within(row).getByRole('link', { name: /Netflix/ })).toBeTruthy();
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

  it('changes the status of a season from its row, and saves it', async () => {
    const app = renderApp({
      route: `/franchise/${FRANCHISE}`,
      handler: server(mine(), (call) =>
        call.method === 'PATCH' ? json(200, { data: entryDetail(3, 'on_hold', 2) }) : undefined,
      ),
    });
    const select = await screen.findByRole<HTMLSelectElement>('combobox', {
      name: 'Status of Season 3',
    });
    expect(select.value).toBe('watching');
    await app.user.selectOptions(select, 'on_hold');
    await waitFor(() => {
      expect(app.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
    });
    expect(app.calls.find((call) => call.method === 'PATCH')?.body).toEqual({ status: 'on_hold' });
    expect(await screen.findByText('On hold · 2 / 5')).toBeTruthy();
    // A season that is not in the library has no status to change.
    expect(screen.queryByRole('combobox', { name: 'Status of The Movie' })).toBeNull();
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
