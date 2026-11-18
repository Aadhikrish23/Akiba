import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { setAniList, signedIn } from './helpers';

/**
 * T22 journeys: from a title to its cast, a character, its studio and its franchise, in real Chrome
 * against the built web app, the built API, a real database and a mock of AniList that replays the
 * recorded Attack on Titan detail (cast of 25, studio, relations). FR-EXP-001…004.
 */

test.beforeEach(async () => {
  await setAniList('ok');
});

async function openAttackOnTitan(page: Page): Promise<void> {
  await page.goto('/discover?q=attack%20on%20titan');
  await page.getByRole('link', { name: 'Shingeki no Kyojin', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Shingeki no Kyojin' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Characters' })).toBeVisible();
}

test('journey: title → cast → character → back to the title (FR-EXP-004)', async ({ page }) => {
  await signedIn(page, 'cast');
  await openAttackOnTitan(page);

  const cast = page.getByRole('list', { name: 'Characters' }).getByRole('listitem');
  await expect(cast).toHaveCount(25);
  // Main characters come first, each with the voice actor.
  await expect(cast.first()).toContainText('Main character');
  await expect(cast.filter({ hasText: 'Eren Yeager' })).toContainText('voiced by Yuuki Kaji');

  await page.getByRole('link', { name: 'Eren Yeager', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Eren Yeager' })).toBeVisible();
  await expect(page.getByText('エレン・イェーガー', { exact: true })).toBeVisible();
  await expect(page.getByText('Voiced by (Japanese)')).toBeVisible();
  await expect(page.getByText('Yuuki Kaji')).toBeVisible();
  // The description is plain text: no markup and no spoiler markers from the source.
  const text = await page.locator('main').innerText();
  expect(text).not.toMatch(/~!|!~|<[a-z]|\]\(/i);
  const appears = page.getByRole('list', { name: 'Appearances' });
  await expect(appears.getByText('Main character')).toBeVisible();
  await appears.getByRole('link', { name: 'Shingeki no Kyojin' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Shingeki no Kyojin' })).toBeVisible();
});

test('journey: title → studio → its works (FR-EXP-003)', async ({ page }) => {
  await signedIn(page, 'studio');
  await openAttackOnTitan(page);
  await page.getByRole('link', { name: 'WIT STUDIO', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'WIT STUDIO' })).toBeVisible();
  await expect(page.getByText(/works? saved in Akiba/)).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Works' }).getByRole('link', { name: 'Shingeki no Kyojin' }),
  ).toBeVisible();
});

test('journey: title → franchise, with my status on each entry (FR-EXP-001, FR-EXP-002)', async ({
  page,
}) => {
  await signedIn(page, 'franchise');
  await openAttackOnTitan(page);
  await page.getByLabel('Status').selectOption('watching');
  await page.getByRole('button', { name: 'Add to library' }).click();
  await expect(page.getByRole('heading', { name: 'On your shelf' })).toBeVisible();

  await page.getByRole('link', { name: 'See the whole franchise' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Shingeki no Kyojin' })).toBeVisible();
  const rows = page
    .getByRole('list', { name: 'Titles in this franchise, oldest first' })
    .getByRole('article');
  expect(await rows.count()).toBeGreaterThan(3);
  await expect(page.getByRole('status')).toContainText('1 on your shelf, 0 completed.');
  // The one I added says so; the others do not, and each row says how it relates.
  const mine = rows.filter({ hasText: 'On your shelf: Watching' });
  await expect(mine).toHaveCount(1);
  await expect(mine).toContainText('Shingeki no Kyojin');
  await expect(mine.getByText('After this')).toBeVisible();
  await expect(rows.filter({ hasText: 'Not on your shelf' }).first()).toBeVisible();

  // A row opens that title's own page.
  await page.getByRole('link', { name: 'Shingeki no Kyojin Season 2' }).first().click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Shingeki no Kyojin Season 2' }),
  ).toBeVisible();
});

test('a franchise, studio or character that does not exist says so', async ({ page }) => {
  await signedIn(page, 'missing');
  const nil = '00000000-0000-4000-8000-000000000000';
  for (const [path, heading] of [
    [`/franchise/${nil}`, 'Franchise not found'],
    [`/studio/${nil}`, 'Studio not found'],
    [`/character/${nil}`, 'Character not found'],
    ['/character/not-an-id', 'Character not found'],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  }
});

for (const scheme of ['light', 'dark'] as const) {
  test(`accessibility (WCAG 2.2 AA, ${scheme}): title with cast, franchise, studio, character`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await signedIn(page, `axe-explore-${scheme}`);
    const check = async (label: string) => {
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(
        results.violations.map((v) => `${label}: ${v.id} ${v.help} (${v.nodes.length})`),
      ).toEqual([]);
    };

    await openAttackOnTitan(page);
    await check('title page');

    await page.getByRole('link', { name: 'Eren Yeager', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Eren Yeager' })).toBeVisible();
    await check('character');

    await page.goBack();
    await page.getByRole('link', { name: 'See the whole franchise' }).click();
    await expect(
      page.getByRole('list', { name: 'Titles in this franchise, oldest first' }),
    ).toBeVisible();
    await check('franchise');

    await page.goBack();
    await page.getByRole('link', { name: 'WIT STUDIO', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'WIT STUDIO' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Works' })).toBeVisible();
    await check('studio');
  });
}
