import AxeBuilder from '@axe-core/playwright';
import { expect, request, test, type Page } from '@playwright/test';
import {
  PASSWORD,
  SHOW,
  runJob,
  setAiringEpisode,
  setAniList,
  signedIn,
  watchTheShow,
} from './helpers';

/**
 * The Schedule screen (doc 08 §1) in a real browser: an episode "airs" through the real airing-sync
 * job against the mock AniList (one episode, aired an hour ago), then the account's week shows it
 * in broadcast time, `+1` stamps it, and it is the same slot on Home's week strip.
 */

// Episode numbers far from the inbox spec's (100-900): an episode is announced once, ever.
let nextEpisode = 5000 + (Date.now() % 4000);

test.beforeEach(async () => {
  await setAniList('ok');
  nextEpisode += 1;
  await setAiringEpisode(nextEpisode);
});

interface Slot {
  episode: number;
  airsAt: string;
}

/**
 * The web app keeps its access token in memory, so a test that talks to the API itself signs in
 * once more (a separate session) and sends that token.
 */
async function api(email: string) {
  const context = await request.newContext({
    baseURL: 'http://localhost:4173',
    extraHTTPHeaders: { 'X-Client': 'web' },
  });
  const login = await context.post('/v1/auth/login', { data: { email, password: PASSWORD } });
  expect(login.ok()).toBe(true);
  const { accessToken } = (await login.json()) as { accessToken: string };
  const headers = { Authorization: `Bearer ${accessToken}` };
  return {
    get: (path: string) => context.get(path, { headers }),
    post: (path: string, data: unknown) => context.post(path, { headers, data }),
    put: (path: string, data: unknown) => context.put(path, { headers, data }),
    close: () => context.dispose(),
  };
}

/** A fresh account that is Watching the airing show, with progress one episode short of the aired one. */
async function watchingAnAiredEpisode(page: Page, label: string): Promise<string> {
  const email = await signedIn(page, label);
  await watchTheShow(page);
  runJob('airing-sync');
  const server = await api(email);
  const list = await server.get('/v1/library');
  const entryId = ((await list.json()) as { data: { id: string }[] }).data[0]?.id;
  expect(entryId).toBeDefined();
  // The show's known total is far below this episode number; the user's own override lifts it.
  const total = await server.put(`/v1/library/${entryId}/episodes-total`, { total: nextEpisode });
  expect(total.ok()).toBe(true);
  const progress = await server.post(`/v1/library/${entryId}/progress`, {
    set: nextEpisode - 1,
  });
  expect(progress.ok()).toBe(true);
  await server.close();
  return email;
}

/** The slot of this test's episode as the server reports it (a wide window around now). */
async function airedSlot(email: string): Promise<Slot> {
  const server = await api(email);
  const from = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const to = new Date(Date.now() + 3 * 86_400_000).toISOString();
  const response = await server.get(`/v1/library/schedule?from=${from}&to=${to}`);
  expect(response.ok()).toBe(true);
  const slots = ((await response.json()) as { data: Slot[] }).data;
  await server.close();
  const slot = slots.find((candidate) => candidate.episode === nextEpisode);
  expect(slot, 'the synced episode is on the schedule').toBeDefined();
  return slot!;
}

const slotGroup = (page: Page, state: string | RegExp) =>
  page.getByRole('group', {
    name:
      typeof state === 'string'
        ? `${SHOW}, episode ${nextEpisode}, ${state}`
        : new RegExp(`^${SHOW}, episode ${nextEpisode}, ${state.source}`),
  });

/**
 * The episode aired an hour ago. In the one hour after Monday 0:00 that is still last week's
 * Sunday night, so step back a week when this one does not show it.
 */
async function showTheAiredWeek(page: Page): Promise<void> {
  await expect(page.getByRole('table', { name: /Weekly airing schedule/ })).toBeVisible();
  await expect(page.getByText('Loading your week…')).toHaveCount(0);
  if ((await slotGroup(page, /./).count()) === 0) {
    await page.getByRole('button', { name: 'Previous week' }).click();
    await expect(slotGroup(page, /./).first()).toBeVisible();
  }
}

test('an aired episode waits on your week, +1 stamps it, and Home shows the same slot', async ({
  page,
}) => {
  await watchingAnAiredEpisode(page, 'schedule');

  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Schedule' })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Your week, on air.' })).toBeVisible();
  await showTheAiredWeek(page);
  // Other episodes of the shared title may also be waiting, so only this test's slot is counted on.
  await expect(page.getByText(/aired and (is|are) waiting for a stamp/)).toBeVisible();
  const waiting = slotGroup(page, /[A-Z]{3} \d+:\d{2}, aired, not yet watched$/);
  await expect(waiting.first()).toBeVisible();

  const logged = page.waitForResponse(
    (response) => response.url().includes('/progress') && response.request().method() === 'POST',
  );
  await waiting
    .first()
    .getByRole('button', { name: `+1 episode of ${SHOW}` })
    .click();
  expect((await logged).ok()).toBe(true);
  await expect(slotGroup(page, /[A-Z]{3} \d+:\d{2}, watched$/).first()).toBeVisible();
  await expect(waiting).toHaveCount(0);

  // It is saved: a reload keeps the slot watched.
  await page.reload();
  await showTheAiredWeek(page);
  await expect(slotGroup(page, /[A-Z]{3} \d+:\d{2}, watched$/).first()).toBeVisible();

  // Home's week strip carries the same slot, and its link goes to the full schedule.
  await page.goto('/');
  const strip = page.getByRole('group', { name: 'Episodes this week' });
  await expect(strip).toBeVisible();
  await page.getByRole('link', { name: 'Full schedule' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Your week, on air.' })).toBeVisible();
});

test('the week is in the account time zone, and 1-6 am is written past 24', async ({ page }) => {
  const email = await watchingAnAiredEpisode(page, 'schedule-zone');
  await page.goto('/settings');
  await page.getByLabel('Time zone').fill('Asia/Tokyo');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved.')).toBeVisible();

  // What the page must say, worked out here from the server's own air time.
  const { airsAt } = await airedSlot(email);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo',
    hourCycle: 'h23',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(new Date(airsAt));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const hour = Number(part('hour'));
  const late = hour < 6;
  const weekday = part('weekday').toUpperCase();
  const days = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
  const day = late ? days[(days.indexOf(weekday) + 6) % 7] : weekday;
  const clock = `${late ? hour + 24 : hour}:${part('minute').padStart(2, '0')}`;

  await page.goto('/schedule');
  await expect(page.getByRole('table', { name: /Weekly airing schedule/ })).toBeVisible();
  // Tokyo is nine hours ahead; the aired hour may belong to either neighbouring week.
  if ((await slotGroup(page, /./).count()) === 0) {
    await page.getByRole('button', { name: 'Previous week' }).click();
  }
  await expect(slotGroup(page, `${day} ${clock}, aired, not yet watched`).first()).toBeVisible();
});

test('steps to next week and back, and says so when nothing airs', async ({ page }) => {
  await signedIn(page, 'schedule-empty');
  await page.goto('/schedule');
  await expect(page.getByRole('heading', { level: 1, name: 'Your week, on air.' })).toBeVisible();
  await expect(page.getByText('Nothing from your list airs this week.').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Find something to watch' })).toBeVisible();

  const range = page.getByText(/^[A-Z][a-z]{2} \d+ – /);
  const thisWeek = await range.textContent();
  await page.getByRole('button', { name: 'Next week' }).click();
  await expect(range).not.toHaveText(thisWeek!);
  await expect(page.getByRole('button', { name: 'Next week' })).toBeDisabled();
  await page.getByRole('button', { name: 'This week' }).click();
  await expect(range).toHaveText(thisWeek!);

  await page.getByRole('link', { name: 'Find something to watch' }).click();
  await expect(page).toHaveURL(/\/discover/);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`accessibility (WCAG 2.2 AA, ${scheme}): the Schedule with an aired and a watched slot, on a phone, and next week`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await watchingAnAiredEpisode(page, `axe-schedule-${scheme}`);
    const check = async (label: string) => {
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(
        results.violations.map((v) => `${label}: ${v.id} ${v.help} (${v.nodes.length})`),
      ).toEqual([]);
    };

    await page.goto('/schedule');
    await showTheAiredWeek(page);
    await check('week, an aired slot');

    await page
      .getByRole('button', { name: `+1 episode of ${SHOW}` })
      .first()
      .click();
    await expect(slotGroup(page, /[A-Z]{3} \d+:\d{2}, watched$/).first()).toBeVisible();
    await check('week, a watched slot');

    // Phones get a day agenda instead of the grid.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('tablist', { name: 'Day of the week' })).toBeVisible();
    await check('day agenda on a phone');
    await page.setViewportSize({ width: 1280, height: 720 });

    // Next week holds the carried-forward weekly slot, or nothing if the show's total ends first.
    await page.getByRole('button', { name: 'Next week' }).click();
    await expect(page.getByRole('button', { name: 'This week' })).toBeVisible();
    await expect(page.getByText('Loading your week…')).toHaveCount(0);
    await check('next week');
  });
}
