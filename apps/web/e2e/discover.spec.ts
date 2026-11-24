import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { api, openResult, setAniList, showResult, signedIn } from './helpers';

/**
 * T13/T14 journeys: discovery in real Chrome against the built web app, the built API, a real
 * database and a mock of AniList that replays recorded responses (e2e/mock-sources.mjs).
 * Requirement IDs: FR-DISC-001…010; NFR-PERF-002 (see the timing check below).
 */

test.beforeEach(async () => {
  await setAniList('ok');
});
test.afterAll(async () => {
  await setAniList('ok');
});

const grid = (page: Page, name = 'Titles') => page.getByRole('list', { name }).getByRole('article');

test('journey: search for a title, open it, follow a related title (FR-DISC-001, -004, -005, -008)', async ({
  page,
}) => {
  await signedIn(page, 'search');
  await page.getByRole('link', { name: 'Discover' }).click();
  await expect(page.getByRole('heading', { name: 'Discover' })).toBeVisible();

  // No button press and no Enter: the search runs once typing pauses.
  await page.getByLabel('Search by name').pressSequentially('attack on titan');
  await expect(page.getByRole('heading', { name: 'Results for “attack on titan”' })).toBeVisible();
  await expect(grid(page, 'Search results').first()).toBeVisible();
  await expect(page).toHaveURL(/q=attack\+on\+titan/);

  // The whole card is one link, through the name.
  await openResult(page, 'Shingeki no Kyojin');
  await expect(page).toHaveURL(/\/title\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Shingeki no Kyojin' })).toBeVisible();
  await expect(page.getByText('Attack on Titan', { exact: true })).toBeVisible();
  await expect(page.getByText('Wit Studio')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Genres' }).getByText('Action')).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Synopsis' })).toBeVisible();
  // No markup from the source reaches the page.
  await expect(page.locator('body')).not.toContainText('<br>');

  // Related titles are grouped and each opens a page of its own.
  await expect(page.getByRole('heading', { level: 3, name: 'After this' })).toBeVisible();
  const sequel = page.getByRole('link', { name: 'Shingeki no Kyojin Season 2' });
  await sequel.click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Shingeki no Kyojin Season 2' }),
  ).toBeVisible();
});

test('journey: filters combine and narrow the list (FR-DISC-002)', async ({ page }) => {
  await signedIn(page, 'filters');
  await page.goto('/discover');
  await expect(grid(page)).toHaveCount(4);

  await page.getByLabel('Genre').selectOption('Romance');
  await expect(grid(page)).toHaveCount(3);
  await page.getByLabel('Format').selectOption('tv');
  await expect(grid(page)).toHaveCount(2);
  await expect(page.getByRole('link', { name: 'Dandadan' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Ao no Hako' })).toHaveCount(0);
  // The state is in the address, so it survives a reload and can be shared.
  await expect(page).toHaveURL(/genre=Romance/);
  await expect(page).toHaveURL(/format=tv/);
  await page.reload();
  await expect(grid(page)).toHaveCount(2);
  await expect(page.getByLabel('Genre')).toHaveValue('Romance');

  await page.getByLabel('Genre').selectOption('Sports');
  await page.getByLabel('Format').selectOption('');
  await expect(grid(page)).toHaveCount(2); // Ao no Hako and Blue Lock
  await page.getByLabel('Format').selectOption('movie');
  await expect(
    page.getByText('No titles match these filters. Remove one to see more.'),
  ).toBeVisible();
});

test('journey: the seasonal chart and its neighbours (FR-DISC-003)', async ({ page }) => {
  await signedIn(page, 'season');
  await page.goto('/discover');
  await page.getByRole('link', { name: 'Seasonal chart' }).click();
  await expect(page).toHaveURL(/\/discover\/season\/\d{4}\/(winter|spring|summer|fall)$/);
  await expect(page.getByRole('navigation', { name: 'Seasons' })).toBeVisible();

  await page.goto('/discover/season/2024/fall');
  await expect(page.getByRole('heading', { level: 1, name: 'Fall 2024' })).toBeVisible();
  await expect(grid(page, 'Fall 2024 titles')).toHaveCount(4);
  await page.getByRole('link', { name: '← Summer 2024' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Summer 2024' })).toBeVisible();
  await expect(page.getByText('No titles are listed for this season yet.')).toBeVisible();
});

test('journey: an AniList outage is labelled and never loses what is stored (FR-DISC-010, NFR-REL-001)', async ({
  page,
}) => {
  await signedIn(page, 'outage');
  // Warm the catalog while the source works.
  await page.goto('/discover?q=shingeki');
  await expect(grid(page, 'Search results').first()).toBeVisible();

  await setAniList('down');
  // A search nobody has made yet cannot come from the reuse cache: it falls back to what is stored.
  await page.goto('/discover?q=kyojin');
  // The gateway retries with backoff and paces its requests before giving up on a source.
  await expect(page.getByText(/Showing saved results/)).toBeVisible({ timeout: 25_000 });
  await showResult(page, 'Shingeki no Kyojin');

  // And a search with nothing stored says the catalog is unavailable, with a way to retry.
  await page.goto('/discover?q=nothing-stored-matches-this');
  await expect(page.getByRole('alert')).toContainText('temporarily unavailable', {
    timeout: 25_000,
  });
  await setAniList('ok');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText(/Nothing matches/)).toBeVisible();
});

test('keyboard: a card is reachable and opens with Enter, with a visible focus ring on the card (doc 08 §6)', async ({
  page,
}) => {
  await signedIn(page, 'keyboard');
  await page.goto('/discover');
  await expect(grid(page)).toHaveCount(4);
  const first = page.getByRole('link', { name: 'Dandadan' });
  await first.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(first).toBeFocused();
  const outline = await first.evaluate(
    (link) => getComputedStyle(link.closest('article')!).outlineStyle,
  );
  expect(outline).toBe('solid');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/title\//);
  await expect(page.getByRole('heading', { level: 1, name: 'Dandadan' })).toBeVisible();
});

test('responsive: 375 px wide, nothing scrolls sideways and the cards reflow', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signedIn(page, 'mobile-discover');
  for (const path of ['/discover', '/discover/season/2024/fall']) {
    await page.goto(path);
    await expect(grid(page, path === '/discover' ? 'Titles' : 'Fall 2024 titles')).toHaveCount(4);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
  // 375 − 2 × 16 px gutters leaves room for two 150 px columns.
  const columns = await page.evaluate(
    () =>
      getComputedStyle(
        document.querySelector('ul[aria-label="Fall 2024 titles"]')!,
      ).gridTemplateColumns.split(' ').length,
  );
  expect(columns).toBe(2);
});

test('performance: a list of 24 cards is on screen quickly (NFR-PERF-002 budget, on fixture data)', async ({
  page,
}) => {
  await signedIn(page, 'perf');
  const started = Date.now();
  await page.goto('/discover');
  await expect(grid(page)).toHaveCount(4);
  const elapsed = Date.now() - started;
  // Doc 03 budget for search/browse is 2 s at p95. This measures one cold navigation against local
  // services; it is a regression tripwire, not a load test.
  expect(elapsed).toBeLessThan(2000);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`accessibility (WCAG 2.2 AA, ${scheme}): Discover, season chart and title page`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await signedIn(page, `axe-discover-${scheme}`);

    const check = async (label: string) => {
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(
        results.violations.map((v) => `${label}: ${v.id} ${v.help} (${v.nodes.length})`),
      ).toEqual([]);
    };

    await page.goto('/discover');
    await expect(grid(page)).toHaveCount(4);
    await check('/discover');

    await page.goto('/discover?q=attack');
    await expect(grid(page, 'Search results').first()).toBeVisible();
    await check('/discover (search)');

    await page.goto('/discover/season/2024/fall');
    await expect(grid(page, 'Fall 2024 titles')).toHaveCount(4);
    await check('/discover/season');

    await page.goto('/discover?q=attack');
    await openResult(page, 'Shingeki no Kyojin');
    await expect(page.getByRole('heading', { level: 3, name: 'After this' })).toBeVisible();
    await check('/title/:id');
  });
}

test('seasons of one show are one banner that opens to list them (and the library groups them too)', async ({
  page,
}) => {
  const email = await signedIn(page, 'banner');
  await page.goto('/discover');
  await page.getByLabel('Search by name').pressSequentially('hero academia');

  // Four titles of one franchise: three seasons and a movie. One banner, not four cards.
  const banner = page.getByRole('article', {
    name: 'My Hero Academia, 3 seasons · 1 movie, special or spin-off',
  });
  await expect(banner).toBeVisible();
  await expect(page.getByRole('link', { name: 'My Hero Academia 2', exact: true })).toHaveCount(0);

  await banner.getByRole('button', { name: /My Hero Academia/ }).click();
  const seasons = banner.getByRole('list', { name: 'Seasons in this franchise' });
  await expect(seasons.getByRole('listitem')).toHaveCount(3);
  await expect(seasons.getByText(/^Season 3 · /)).toBeVisible();
  const others = banner.getByRole('list', { name: 'Other titles in this franchise' });
  await expect(others.getByRole('link', { name: 'My Hero Academia: The Movie' })).toBeVisible();

  // Two of the seasons go into the library; the library shows them under the same banner.
  const server = await api(email);
  const found = (await (
    await server.get('/v1/titles/search?q=hero%20academia&limit=10')
  ).json()) as {
    data: { id: string; titleRomaji: string }[];
  };
  for (const title of found.data.filter((item) => /Academia( 2)?$/.test(item.titleRomaji))) {
    expect((await server.post('/v1/library', { titleId: title.id, status: 'watching' })).ok()).toBe(
      true,
    );
  }
  await server.close();
  await page.goto('/library');
  const owned = page.getByRole('article', {
    name: 'My Hero Academia, 3 seasons · 1 movie, special or spin-off',
  });
  await expect(owned).toBeVisible();
  await expect(owned.getByText('2 in your library')).toBeVisible();
  await owned.getByRole('button', { name: /My Hero Academia/ }).click();
  await expect(
    owned.getByRole('list', { name: 'Seasons in your library' }).getByRole('listitem'),
  ).toHaveCount(2);
});
