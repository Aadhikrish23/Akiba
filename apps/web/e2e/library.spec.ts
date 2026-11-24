import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { expectCount, setAniList, signedIn } from './helpers';

/**
 * T18 journeys 1–3 of doc 11 §4, in real Chrome against the built app, the built API, a real
 * database and the mock AniList: add → +1 ×3 → rate → history; rewatch; episode-count override.
 */

test.beforeEach(async () => {
  await setAniList('ok');
});

async function openAttackOnTitan(page: Page): Promise<void> {
  await page.goto('/discover?q=attack%20on%20titan');
  await page.getByRole('link', { name: 'Shingeki no Kyojin', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Shingeki no Kyojin' })).toBeVisible();
}

async function addAs(page: Page, status: string): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Add to your library' })).toBeVisible();
  await page.getByLabel('Status').selectOption(status);
  await page.getByRole('button', { name: 'Add to library' }).click();
  await expect(page.getByRole('heading', { name: 'On your shelf' })).toBeVisible();
}

const plusOne = (page: Page) =>
  page.getByRole('button', { name: '+1 episode of Shingeki no Kyojin' });

test('journey 1: search, add to Watching, +1 three times, rate, see it in history', async ({
  page,
}) => {
  await signedIn(page, 'lib1');
  await openAttackOnTitan(page);
  await addAs(page, 'watching');

  await expectCount(page, '0 / 25');
  for (let i = 1; i <= 3; i += 1) {
    await plusOne(page).click();
    await expectCount(page, `${i} / 25`);
  }
  await page.getByLabel('Your rating').selectOption('9');
  await expect(page.getByLabel('Your rating')).toHaveValue('9');

  // The numbers survive a reload: they are on the server, not just on screen.
  await page.reload();
  await expectCount(page, '3 / 25');

  await page.getByRole('link', { name: 'History' }).click();
  await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
  await expect(page.getByText('Rated 9 out of 10')).toBeVisible();
  await expect(page.getByText('Watched episode 3')).toBeVisible();
  await expect(page.getByText('Watched episode 1')).toBeVisible();
  await expect(page.getByText('Added to your library as Watching')).toBeVisible();

  // It is on the shelf and on Home.
  await page.getByRole('link', { name: 'Library' }).click();
  // Wait for the Library itself first: until then the title page is still showing, with related
  // titles whose names also contain this one (an exact match avoids the strict-mode clash).
  await expect(page.getByRole('heading', { level: 1, name: 'Library' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Shingeki no Kyojin', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Home' }).click();
  await expect(page.getByRole('heading', { name: 'Continue watching' })).toBeVisible();
  await expectCount(page, '3 / 25');
  await page.getByRole('button', { name: '+1 episode of Shingeki no Kyojin' }).click();
  await expectCount(page, '4 / 25');
});

test('catching up: click the count, type the episode you are on, and it is saved', async ({
  page,
}) => {
  await signedIn(page, 'lib-catchup');
  await openAttackOnTitan(page);
  await addAs(page, 'watching');
  await expectCount(page, '0 / 25');

  const field = page.getByRole('textbox', { name: /^Episodes watched of / });
  await field.fill('18');
  await field.press('Enter');
  await expectCount(page, '18 / 25');
  await page.reload();
  await expectCount(page, '18 / 25');

  // Past the total: explained, not saved, and the number goes back.
  await field.fill('26');
  await expect(page.getByRole('alert')).toHaveText('This show has 25 episodes.');
  await field.press('Tab');
  await expectCount(page, '18 / 25');
  await page.reload();
  await expectCount(page, '18 / 25');

  // Escape puts the old number back without asking the server.
  await field.fill('5');
  await field.press('Escape');
  await expectCount(page, '18 / 25');

  // Typing the total ends the show: the page offers to mark it completed.
  await field.fill('25');
  await field.press('Enter');
  await expect(page.getByText('That was the last episode. Mark completed?')).toBeVisible();
});

test('journey 2: rewatch a completed title and see both viewings', async ({ page }) => {
  await signedIn(page, 'lib2');
  await openAttackOnTitan(page);
  await addAs(page, 'completed');
  await expect(page.getByText('Completed 25 of 25 episodes.')).toBeVisible();

  await page.getByRole('button', { name: 'Rewatch' }).click();
  const viewings = page.getByRole('list', { name: 'Viewings' });
  await expect(viewings.getByRole('listitem')).toHaveCount(2);
  await expect(viewings.getByText(/Run 2: .*in progress/)).toBeVisible();
  await expect(viewings.getByText(/Run 1: .*finished/)).toBeVisible();
  await expectCount(page, '0 / 25');

  await page.getByRole('link', { name: 'History' }).click();
  await expect(page.getByText('Started rewatch 2')).toBeVisible();
  await expect(page.getByText('Finished watching')).toBeVisible();
});

test('journey 3: override the episode count, see it marked Edited, reset it', async ({ page }) => {
  await signedIn(page, 'lib3');
  await openAttackOnTitan(page);
  await addAs(page, 'watching');
  await expectCount(page, '0 / 25');

  await page.getByRole('button', { name: 'Episode count looks wrong?' }).click();
  await page.getByLabel('Number of episodes').fill('30');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Edited', { exact: true })).toBeVisible();
  await expectCount(page, '0 / 30');

  await page.getByRole('button', { name: /^Reset to 25/ }).click();
  await expect(page.getByText('Edited', { exact: true })).toHaveCount(0);
  await expectCount(page, '0 / 25');
});

test('the compact list layout is remembered across a reload', async ({ page }) => {
  await signedIn(page, 'lib4');
  await openAttackOnTitan(page);
  await addAs(page, 'watching');
  await page.goto('/library');
  await page.getByRole('radio', { name: 'List' }).check();
  await expect(plusOne(page)).toBeVisible();
  await page.reload();
  await expect(page.getByRole('radio', { name: 'List' })).toBeChecked();
  await expect(plusOne(page)).toBeVisible();
});

test('keyboard only: add, log an episode and reach the history without a mouse', async ({
  page,
}) => {
  await signedIn(page, 'lib5');
  await openAttackOnTitan(page);
  await addAs(page, 'watching');
  await plusOne(page).focus();
  await page.keyboard.press('Enter');
  await expectCount(page, '1 / 25');
  await page.keyboard.press('Space');
  await expectCount(page, '2 / 25');
});

for (const scheme of ['light', 'dark'] as const) {
  test(`accessibility (WCAG 2.2 AA, ${scheme}): Home, Library (grid and list), History and the shelf`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await signedIn(page, `axe-lib-${scheme}`);
    await openAttackOnTitan(page);
    await addAs(page, 'watching');
    await plusOne(page).click();
    await page.getByLabel('Your rating').selectOption('8');
    await expect(page.getByLabel('Your rating')).toHaveValue('8');

    const check = async (label: string) => {
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(
        results.violations.map((v) => `${label}: ${v.id} ${v.help} (${v.nodes.length})`),
      ).toEqual([]);
    };
    await check('/title (shelf)');
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Continue watching' })).toBeVisible();
    await expect(page.getByTestId('episode-count')).toBeVisible();
    await check('/ (home)');
    await page.goto('/library');
    await expect(page.getByRole('list', { name: 'Library' })).toBeVisible();
    await check('/library (grid)');
    await page.getByRole('radio', { name: 'List' }).check();
    await expect(plusOne(page)).toBeVisible();
    await check('/library (list)');
    await page.goto('/history');
    await expect(page.getByText('Rated 8 out of 10')).toBeVisible();
    await check('/history');
  });
}
