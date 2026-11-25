import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  SHOW,
  logIn,
  runJob,
  setAiringEpisode,
  setAniList,
  signUp,
  unique,
  watchTheShow,
} from './helpers';

/**
 * T24 journey 6 of doc 11 §4: an episode airs → the badge → read. The episode "airs" through the
 * real airing-sync and inbox-fanout jobs (the API's own command, `jobs:run`) against the mock
 * AniList, which reports one episode aired an hour ago for every title it is asked about.
 * FR-NOTE-001…005.
 */

let nextEpisode = 100 + (Date.now() % 800);

test.beforeEach(async () => {
  await setAniList('ok');
  // Each test gets an episode of its own: an episode is announced once, ever.
  nextEpisode += 1;
  await setAiringEpisode(nextEpisode);
});

/** A signed-in account (verification is not needed for the inbox). */
async function account(page: Page, label: string): Promise<string> {
  const email = unique(label);
  await signUp(page, email);
  await logIn(page, email);
  await expect(page.getByRole('heading', { name: 'Welcome, Hana' })).toBeVisible();
  return email;
}

/** Coming back to the tab asks the server for the count again. */
const backToTab = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('focus')));
const inboxLink = (page: Page, name: string | RegExp) =>
  page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name });

test('journey 6: an episode airs → the badge appears → mark read → it stays read', async ({
  page,
}) => {
  await account(page, 'inbox');
  await watchTheShow(page);
  await expect(inboxLink(page, 'Inbox')).toBeVisible(); // nothing yet, no badge

  runJob('airing-sync');
  await backToTab(page);
  await expect(inboxLink(page, 'Inbox 1 unread')).toBeVisible();

  await inboxLink(page, 'Inbox 1 unread').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();
  const row = page.getByRole('list', { name: 'Notifications' }).getByRole('listitem');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(SHOW);
  await expect(row).toContainText(`Episode ${nextEpisode} aired`);
  await expect(row.getByText('New', { exact: true })).toBeVisible();
  await expect(row.locator('time')).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/);

  await row
    .getByRole('button', { name: `Mark as read: episode ${nextEpisode} of ${SHOW}` })
    .click();
  await expect(row.getByText('New', { exact: true })).toHaveCount(0);
  await expect(inboxLink(page, 'Inbox')).toBeVisible(); // the badge is gone
  await expect(page.getByText('Nothing unread.')).toBeVisible();

  // It is saved, not just shown: a reload keeps it read, and the fan-out never repeats itself.
  runJob('airing-sync');
  runJob('inbox-fanout');
  await page.reload();
  await expect(row).toHaveCount(1);
  await expect(row.getByText('New', { exact: true })).toHaveCount(0);
  await expect(inboxLink(page, 'Inbox')).toBeVisible();

  // Opening the title from the inbox is one click away.
  await row.getByRole('link', { name: SHOW }).click();
  await expect(page.getByRole('heading', { level: 1, name: SHOW })).toBeVisible();
});

test('mark all as read, filter to unread, and delete (FR-NOTE-003)', async ({ page }) => {
  await account(page, 'inbox-bulk');
  await watchTheShow(page);
  runJob('airing-sync');
  await page.goto('/inbox');
  const rows = page.getByRole('list', { name: 'Notifications' }).getByRole('listitem');
  await expect(rows).toHaveCount(1);

  await page.getByLabel('Show').selectOption('Unread only');
  await expect(rows).toHaveCount(1);
  await page.getByRole('button', { name: 'Mark all as read' }).click();
  await expect(page.getByText('You are all caught up.')).toBeVisible();
  await expect(inboxLink(page, 'Inbox')).toBeVisible();

  await page.getByLabel('Show').selectOption('Everything');
  await expect(rows).toHaveCount(1);
  await rows.getByRole('button', { name: `Delete: episode ${nextEpisode} of ${SHOW}` }).click();
  await expect(page.getByText(/Nothing yet\. When a new episode/)).toBeVisible();
  await page.reload();
  await expect(page.getByText(/Nothing yet\. When a new episode/)).toBeVisible();
});

test('alerts: off for the account means no notification, and a title can override it (FR-NOTE-004)', async ({
  page,
  browser,
}) => {
  // Quiet: the account's alerts are off.
  await account(page, 'inbox-quiet');
  await page.goto('/settings');
  await page.getByLabel(/Tell me when a new episode/).uncheck();
  await expect(page.getByText('Saved.')).toBeVisible();
  await watchTheShow(page);

  // Override: the account's alerts are off, but this title's are on.
  const other = await browser.newContext();
  const second = await other.newPage();
  await account(second, 'inbox-override');
  await second.goto('/settings');
  await second.getByLabel(/Tell me when a new episode/).uncheck();
  await expect(second.getByText('Saved.')).toBeVisible();
  await watchTheShow(second);
  await second.getByLabel('Episode alerts for this title').selectOption('On');
  await expect(second.getByLabel('Episode alerts for this title')).toHaveValue('on');

  runJob('airing-sync');

  await backToTab(page);
  await page.goto('/inbox');
  await expect(page.getByText(/Nothing yet\. When a new episode/)).toBeVisible();
  await expect(page.getByText('Episode alerts are off for your account.')).toBeVisible();
  await expect(inboxLink(page, 'Inbox')).toBeVisible();

  await second.goto('/inbox');
  await expect(
    second.getByRole('list', { name: 'Notifications' }).getByRole('listitem'),
  ).toHaveCount(1);
  await other.close();
});

test('the airing time is shown in the reader’s own time zone (Settings → Time zone)', async ({
  page,
}) => {
  await account(page, 'inbox-zone');
  await page.goto('/settings');
  await page.getByLabel('Time zone').selectOption('Asia/Tokyo');
  await expect(page.getByText('Saved.')).toBeVisible();
  await watchTheShow(page);
  runJob('airing-sync');
  await page.goto('/inbox');
  const time = page.getByRole('list', { name: 'Notifications' }).locator('time');
  await expect(time).toBeVisible();
  const iso = (await time.getAttribute('datetime'))!;
  // The expected text is made in the browser itself, so both use the same locale.
  const expected = await page.evaluate(
    (value) =>
      new Date(value).toLocaleString(undefined, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Tokyo',
        timeZoneName: 'short',
      }),
    iso,
  );
  expect(expected).toMatch(/GMT\+9|JST/);
  await expect(time).toHaveText(expected);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`accessibility (WCAG 2.2 AA, ${scheme}): the Inbox with unread and read items, empty, and the alert setting`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await account(page, `axe-inbox-${scheme}`);
    await watchTheShow(page);
    const check = async (label: string) => {
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(
        results.violations.map((v) => `${label}: ${v.id} ${v.help} (${v.nodes.length})`),
      ).toEqual([]);
    };
    await expect(page.getByLabel('Episode alerts for this title')).toBeVisible();
    await check('title page with the alert setting');

    await page.goto('/inbox');
    await expect(page.getByText(/Nothing yet\. When a new episode/)).toBeVisible();
    await check('inbox, empty');

    runJob('airing-sync');
    await page.reload();
    await expect(inboxLink(page, 'Inbox 1 unread')).toBeVisible();
    await check('inbox, one unread (badge and New marker)');

    await page.getByRole('button', { name: /^Mark as read/ }).click();
    await expect(page.getByText('Nothing unread.')).toBeVisible();
    await check('inbox, read');
  });
}
