import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, problem, renderApp, signedInHandler, violations, type Call } from './test/render';

/**
 * T22: the franchise, studio and character pages, and the cast and links on the title page, with
 * the real API client over a fake network. Requirement IDs: FR-EXP-001 (franchise grouped by
 * relation), -002 (your status on each entry), -003 (studio page), -004 (character page).
 */

const META = { stale: false, source: 'cache' };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const card = (n: number, extra: Record<string, unknown> = {}) => ({
  id: id(n),
  kind: 'tv',
  titleRomaji: `Show ${n}`,
  titleEnglish: null,
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

const handler = (routes: (call: Call) => Response | undefined) =>
  signedInHandler({}, (call) => routes(call) ?? problem(404, 'NOT_FOUND'));

describe('Studio page (FR-EXP-003)', () => {
  const STUDIO = id(800);
  const studio = { id: STUDIO, name: 'Wit Studio', isAnimationStudio: true, titleCount: 3 };

  it('shows the studio and its works, and loads more on request', async () => {
    const served = handler((call) => {
      if (call.path.endsWith(`/studios/${STUDIO}`)) return json(200, { data: studio, meta: META });
      if (call.path.endsWith(`/studios/${STUDIO}/titles`)) {
        const cursor = new URLSearchParams(call.search).get('cursor');
        return cursor === null
          ? json(200, { data: [card(2), card(3)], nextCursor: 'page2', meta: META })
          : json(200, { data: [card(4)], nextCursor: null, meta: META });
      }
      return undefined;
    });
    const app = renderApp({ route: `/studio/${STUDIO}`, handler: served });
    expect(await screen.findByRole('heading', { level: 1, name: 'Wit Studio' })).toBeTruthy();
    expect(screen.getByText(/3 works saved in Akiba/)).toBeTruthy();
    const works = await screen.findByRole('list', { name: 'Works' });
    expect(within(works).getAllByRole('article')).toHaveLength(2);
    await app.user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => {
      expect(
        within(screen.getByRole('list', { name: 'Works' })).getAllByRole('article'),
      ).toHaveLength(3);
    });
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    const cursors = app.to('/titles').map((call) => new URLSearchParams(call.search).get('cursor'));
    expect(cursors.filter((cursor) => cursor === 'page2')).toHaveLength(1); // asked for once
    expect(cursors.at(-1)).toBe('page2');
    expect(await violations(app.container)).toEqual([]);
  });

  it('says so for a studio with no works yet, and for one that does not exist', async () => {
    renderApp({
      route: `/studio/${STUDIO}`,
      handler: handler((call) => {
        if (call.path.endsWith(`/studios/${STUDIO}`))
          return json(200, { data: { ...studio, titleCount: 0 }, meta: META });
        if (call.path.endsWith('/titles'))
          return json(200, { data: [], nextCursor: null, meta: META });
        return undefined;
      }),
    });
    expect(await screen.findByText('No works are saved for this studio yet.')).toBeTruthy();
    expect(screen.getByText(/0 works saved/)).toBeTruthy();
  });

  it('a missing studio is "Studio not found"', async () => {
    renderApp({ route: `/studio/${STUDIO}`, handler: handler(() => problem(404, 'NOT_FOUND')) });
    expect(await screen.findByRole('heading', { name: 'Studio not found' })).toBeTruthy();
  });
});

describe('Character page (FR-EXP-004)', () => {
  const CHARACTER = id(600);
  const character = {
    id: CHARACTER,
    name: 'Eren Yeager',
    nativeName: 'エレン・イェーガー',
    imageUrl: 'https://img.example.test/eren.jpg',
    description: 'First paragraph.\n\nSecond paragraph.',
    voiceActors: [
      {
        id: id(501),
        name: 'Yuki Kaji',
        nativeName: '梶裕貴',
        imageUrl: null,
        language: 'Japanese',
      },
    ],
    appearances: [
      { role: 'main', title: card(2, { libraryStatus: 'watching', libraryEntryId: id(702) }) },
      { role: 'supporting', title: card(3) },
    ],
  };
  const served = handler((call) =>
    call.path.endsWith(`/characters/${CHARACTER}`)
      ? json(200, { data: character, meta: META })
      : undefined,
  );

  it('shows the character, who voices them, the description and where they appear', async () => {
    const app = renderApp({ route: `/character/${CHARACTER}`, handler: served });
    expect(await screen.findByRole('heading', { level: 1, name: 'Eren Yeager' })).toBeTruthy();
    expect(screen.getByText('エレン・イェーガー').getAttribute('lang')).toBe('ja');
    expect(screen.getByText('Voiced by (Japanese)').nextElementSibling?.textContent).toContain(
      'Yuki Kaji',
    );
    expect(screen.getByText('First paragraph.')).toBeTruthy();
    expect(screen.getByText('Second paragraph.')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Portrait of Eren Yeager' })).toBeTruthy();
    const appears = screen.getByRole('list', { name: 'Appearances' });
    const items = within(appears).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText('Main character')).toBeTruthy();
    expect(within(items[0]!).getByText('Watching')).toBeTruthy(); // the reader's own status
    expect(within(items[1]!).getByText('Supporting character')).toBeTruthy();
    expect(document.title).toBe('Eren Yeager · Akiba');
    expect(await violations(app.container)).toEqual([]);
  });

  it('copes with no picture, no native name, no voice actor and no description', async () => {
    renderApp({
      route: `/character/${CHARACTER}`,
      handler: handler(() =>
        json(200, {
          data: {
            ...character,
            imageUrl: null,
            nativeName: null,
            voiceActors: [],
            description: null,
          },
          meta: META,
        }),
      ),
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Eren Yeager' })).toBeTruthy();
    expect(screen.queryByText(/Voiced by/)).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('a missing character is "Character not found"', async () => {
    renderApp({
      route: `/character/${CHARACTER}`,
      handler: handler(() => problem(404, 'NOT_FOUND')),
    });
    expect(await screen.findByRole('heading', { name: 'Character not found' })).toBeTruthy();
  });
});

describe('Title page: cast, studio links and the franchise link (FR-EXP-001, -003, -004)', () => {
  const TITLE = id(2);
  const detail = (extra: Record<string, unknown> = {}) => ({
    ...card(2),
    synopsis: null,
    bannerUrl: null,
    durationMin: 24,
    startDate: '2024-10-05',
    endDate: null,
    popularity: 10,
    synonyms: [],
    genres: [],
    studios: [
      { id: id(800), name: 'Wit Studio', isMain: true },
      { id: id(801), name: 'MAPPA', isMain: false },
    ],
    nextAiring: null,
    franchiseId: id(900),
    ...extra,
  });
  const cast = [
    {
      id: id(600),
      name: 'Eren Yeager',
      nativeName: null,
      imageUrl: 'https://img.example.test/eren.jpg',
      role: 'main',
      voiceActors: [
        { id: id(501), name: 'Yuki Kaji', nativeName: null, imageUrl: null, language: 'Japanese' },
      ],
    },
    {
      id: id(601),
      name: 'Hannes',
      nativeName: null,
      imageUrl: null,
      role: 'supporting',
      voiceActors: [],
    },
  ];
  const served = (options: { castStatus?: number; franchiseId?: string | null } = {}) =>
    handler((call) => {
      if (call.path.endsWith('/relations')) return json(200, { data: [], meta: META });
      if (call.path.endsWith('/characters')) {
        return options.castStatus === undefined
          ? json(200, { data: cast, meta: META })
          : problem(options.castStatus, 'BOOM');
      }
      if (call.path.endsWith(TITLE)) {
        return json(200, {
          data: detail(
            options.franchiseId === undefined ? {} : { franchiseId: options.franchiseId },
          ),
          meta: META,
        });
      }
      return undefined;
    });

  it('lists the cast with roles and voice actors, each linking to the character page', async () => {
    renderApp({ route: `/title/${TITLE}`, handler: served() });
    const list = await screen.findByRole('list', { name: 'Characters' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByRole('link', { name: 'Eren Yeager' }).getAttribute('href')).toBe(
      `/character/${id(600)}`,
    );
    expect(within(items[0]!).getByText('Main character · voiced by Yuki Kaji')).toBeTruthy();
    expect(within(items[1]!).getByText('Supporting character')).toBeTruthy();
  });

  it('links every studio and the whole franchise', async () => {
    renderApp({ route: `/title/${TITLE}`, handler: served() });
    expect((await screen.findByRole('link', { name: 'Wit Studio' })).getAttribute('href')).toBe(
      `/studio/${id(800)}`,
    );
    expect(screen.getByRole('link', { name: 'MAPPA' }).getAttribute('href')).toBe(
      `/studio/${id(801)}`,
    );
    expect(
      (await screen.findByRole('link', { name: 'See the whole franchise' })).getAttribute('href'),
    ).toBe(`/franchise/${id(900)}`);
  });

  it('offers no franchise link for a title that has none', async () => {
    renderApp({ route: `/title/${TITLE}`, handler: served({ franchiseId: null }) });
    await screen.findByRole('heading', { level: 1, name: 'Show 2' });
    await screen.findByRole('list', { name: 'Characters' });
    expect(screen.queryByRole('link', { name: 'See the whole franchise' })).toBeNull();
  });

  it('a failed cast lookup does not hide the page', async () => {
    renderApp({ route: `/title/${TITLE}`, handler: served({ castStatus: 500 }) });
    expect(await screen.findByRole('heading', { level: 1, name: 'Show 2' })).toBeTruthy();
    expect(await screen.findByText('The characters could not be loaded just now.')).toBeTruthy();
  });

  it('says so when no characters are listed', async () => {
    renderApp({
      route: `/title/${TITLE}`,
      handler: handler((call) => {
        if (call.path.endsWith('/relations')) return json(200, { data: [], meta: META });
        if (call.path.endsWith('/characters')) return json(200, { data: [], meta: META });
        if (call.path.endsWith(TITLE)) return json(200, { data: detail(), meta: META });
        return undefined;
      }),
    });
    expect(await screen.findByText('No characters are listed for this title yet.')).toBeTruthy();
  });

  it('is free of automatically detectable accessibility problems', async () => {
    const app = renderApp({ route: `/title/${TITLE}`, handler: served() });
    await screen.findByRole('list', { name: 'Characters' });
    expect(await violations(app.container)).toEqual([]);
  });
});
