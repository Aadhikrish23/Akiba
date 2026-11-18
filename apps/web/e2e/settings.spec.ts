import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { logIn, PASSWORD, setAniList, signUp, unique } from './helpers';
import { emailedLink } from './mail';

/**
 * T19 journeys 4 and 5 of doc 11 §4 plus settings: share link (limited scope, opened anonymously,
 * revoked), export JSON and CSV, title language, adult toggle, theme, delete and restore.
 */

test.beforeEach(async () => {
  await setAniList('ok');
});

/** Log in and wait for the signed-in screen (navigating away mid-login aborts it). */
async function loggedIn(page: Page, email: string): Promise<void> {
  await logIn(page, email);
  await expect(page.getByRole('heading', { name: 'Welcome, Hana' })).toBeVisible();
}

/** A verified account with Attack on Titan completed, rated and reviewed. */
async function accountWithShelf(page: Page, label: string): Promise<string> {
  const email = unique(label);
  await signUp(page, email);
  await page.goto(await emailedLink(email, 'verify'));
  await expect(page.getByText('Your email address is verified.')).toBeVisible();
  await logIn(page, email);
  await expect(page.getByRole('heading', { name: 'Welcome, Hana' })).toBeVisible();

  await page.goto('/discover?q=attack%20on%20titan');
  await page.getByRole('link', { name: 'Shingeki no Kyojin', exact: true }).click();
  await page.getByLabel('Status').selectOption('completed');
  await page.getByRole('button', { name: 'Add to library' }).click();
  await expect(page.getByRole('heading', { name: 'On your shelf' })).toBeVisible();
  await page.getByLabel('Your rating').selectOption('9');
  await expect(page.getByLabel('Your rating')).toHaveValue('9');
  await page.getByLabel('Your review (private)').fill('A private opinion nobody should see');
  await page.getByRole('button', { name: 'Save review' }).click();
  await expect(page.getByLabel('Your review (private)')).toHaveValue(
    'A private opinion nobody should see',
  );
  return email;
}

test('journey 4: share a limited view, open it anonymously, confirm hidden fields, revoke', async ({
  page,
  browser,
}) => {
  const email = await accountWithShelf(page, 'share');
  await page.goto('/settings');
  const share = page.getByRole('region', { name: 'Share your list' });
  await expect(share.getByRole('button', { name: 'Create link' })).toBeEnabled();
  // Scope: completed only, no ratings, no reviews.
  await share.getByRole('button', { name: 'Create link' }).click();
  const link = await share.getByLabel('Your link (shown once)').inputValue();
  expect(link).toMatch(/\/shared\/[A-Za-z0-9_-]{43}$/);

  // Anyone can open it: a fresh browser context with no cookies and no account.
  const path = new URL(link).pathname;
  const stranger = await browser.newContext();
  const guest = await stranger.newPage();
  await guest.goto(path);
  await expect(guest.getByRole('heading', { name: "Hana's list" })).toBeVisible();
  await expect(guest.getByText('Shingeki no Kyojin')).toBeVisible();
  const body = await guest.locator('body').innerText();
  expect(body).not.toContain('private opinion'); // reviews were not shared
  expect(body).not.toContain('9 / 10'); // nor ratings
  expect(body).not.toContain(email); // nor the account
  await expect(guest.locator('meta[name="robots"]')).toHaveAttribute(
    'content',
    'noindex, nofollow',
  );
  await expect(guest.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');
  const results = await new AxeBuilder({ page: guest })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(results.violations.map((v) => `${v.id} ${v.help}`)).toEqual([]);

  // Now show ratings and reviews: a NEW link is made and the old one stops working at once.
  await share.getByLabel('Show my ratings').check();
  await share.getByLabel('Show my reviews').check();
  await share.getByRole('button', { name: 'Make a new link' }).click();
  await expect(share.getByLabel('Your link (shown once)')).not.toHaveValue(link);
  const fresh = new URL(await share.getByLabel('Your link (shown once)').inputValue()).pathname;
  await guest.reload();
  await expect(guest.getByRole('heading', { name: 'This list is not available' })).toBeVisible();
  await guest.goto(fresh);
  await expect(guest.getByText('9 / 10')).toBeVisible();
  await expect(guest.getByText('A private opinion nobody should see')).toBeVisible();

  // Revoke: dead immediately.
  await share.getByRole('button', { name: 'Turn sharing off' }).click();
  await expect(page.getByText(/stopped working at once/)).toBeVisible();
  await guest.reload();
  await expect(guest.getByRole('heading', { name: 'This list is not available' })).toBeVisible();
  await stranger.close();
});

test('an unverified account is told to verify before sharing', async ({ page }) => {
  const email = unique('unverified-share');
  await signUp(page, email);
  await loggedIn(page, email);
  await page.goto('/settings');
  await expect(page.getByText('Verify your email address to create a share link.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create link' })).toBeDisabled();
});

test('journey 5: export JSON and CSV and check their shape', async ({ page }) => {
  const email = await accountWithShelf(page, 'export');
  await page.goto('/settings');

  const json = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download JSON' }).click();
  const jsonFile = await json;
  expect(jsonFile.suggestedFilename()).toMatch(/^akiba-export-\d{4}-\d{2}-\d{2}\.json$/);
  const data = JSON.parse(readFileSync((await jsonFile.path()) ?? '', 'utf8')) as {
    exportVersion: number;
    user: { email: string };
    entries: {
      status: string;
      rating: number | null;
      review: string | null;
      title: { romaji: string; externalIds: unknown[] };
      runs: unknown[];
    }[];
    events: { type: string }[];
    favorites: string[];
  };
  expect(data.exportVersion).toBe(1);
  expect(data.user.email).toBe(email);
  expect(data.entries).toHaveLength(1);
  expect(data.entries[0]).toMatchObject({
    status: 'completed',
    rating: 9,
    review: 'A private opinion nobody should see',
    title: { romaji: 'Shingeki no Kyojin' },
  });
  expect(data.entries[0]!.title.externalIds.length).toBeGreaterThan(0);
  expect(data.entries[0]!.runs).toHaveLength(1);
  expect(data.events.map((event) => event.type)).toEqual(
    expect.arrayContaining(['entry_added', 'rated', 'reviewed', 'run_completed']),
  );

  const csv = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download CSV' }).click();
  const csvFile = await csv;
  expect(csvFile.suggestedFilename()).toMatch(/^akiba-library-\d{4}-\d{2}-\d{2}\.csv$/);
  const lines = readFileSync((await csvFile.path()) ?? '', 'utf8')
    .trimEnd()
    .split('\r\n');
  expect(lines[0]).toContain('title_romaji,title_english');
  expect(lines).toHaveLength(2);
  expect(lines[1]).toMatch(/^Shingeki no Kyojin,Attack on Titan,/);
  expect(lines[1]).toContain(',completed,25,25,9,');
});

test('settings: language and theme', async ({ page }) => {
  const email = unique('prefs');
  await signUp(page, email);
  await loggedIn(page, email);
  await page.goto('/settings');
  await page.getByLabel('Show titles in').selectOption('english');
  await expect(page.getByText('Saved.')).toBeVisible();
  await page.goto('/discover?q=attack%20on%20titan');
  await expect(page.getByRole('link', { name: 'Attack on Titan', exact: true })).toBeVisible();

  await page.goto('/settings');
  await page.getByRole('radio', { name: 'Dark' }).check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark'); // before first paint
  await page.getByRole('radio', { name: 'Follow my device' }).check();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.*/);

  // The adult setting is a real switch (off by default) and is saved on the account.
  const adult = page.getByLabel(/Show adult-rated titles/);
  await expect(adult).not.toBeChecked();
  await adult.check();
  await expect(page.getByText('Saved.')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel(/Show adult-rated titles/)).toBeChecked();
});

test('delete the account, then restore it within the grace period', async ({ page }) => {
  const email = await accountWithShelf(page, 'delete');
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Delete my account…' }).click();
  await page.getByLabel('Your password').fill('not the password');
  await page.getByRole('button', { name: 'Delete my account', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('current password is incorrect');

  await page.getByLabel('Your password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Delete my account', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Your account is scheduled for deletion' }),
  ).toBeVisible();

  // It can no longer sign in…
  await logIn(page, email);
  await expect(page.getByRole('alert')).toHaveText('The email or password is incorrect.');
  // …until it is restored.
  await page.getByRole('link', { name: 'Restore it' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Restore account' }).click();
  await expect(page.getByRole('heading', { name: 'Account restored' })).toBeVisible();
  await loggedIn(page, email);
  await page.goto('/library');
  await expect(page.getByRole('link', { name: 'Shingeki no Kyojin' })).toBeVisible();
});

for (const scheme of ['light', 'dark'] as const) {
  test(`accessibility (WCAG 2.2 AA, ${scheme}): Settings and the restore screen`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const email = unique(`axe-settings-${scheme}`);
    await signUp(page, email);
    await loggedIn(page, email);
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Delete your account' })).toBeVisible();
    await page.getByRole('button', { name: 'Delete my account…' }).click();
    const check = async (label: string) => {
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(
        results.violations.map((v) => `${label}: ${v.id} ${v.help} (${v.nodes.length})`),
      ).toEqual([]);
    };
    await check('/settings');
    await page.goto('/restore');
    await expect(page.getByRole('heading', { name: 'Restore your account' })).toBeVisible();
    await check('/restore');
  });
}
