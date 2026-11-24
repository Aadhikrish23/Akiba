import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, request, type Page } from '@playwright/test';

export const unique = (label: string): string =>
  `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;

export const PASSWORD = 'correct horse battery staple';

export async function signUp(page: Page, email: string, name = 'Hana'): Promise<void> {
  await page.goto('/register');
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
}

export async function logIn(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
}

/** A fresh account, signed in, on the home screen. */
export async function signedIn(page: Page, label = 'user'): Promise<string> {
  const email = unique(label);
  await signUp(page, email);
  await logIn(page, email);
  await expect(page.getByRole('heading', { name: 'Welcome, Hana' })).toBeVisible();
  return email;
}

/** Switch the mock AniList on or off (see mock-sources.mjs). */
export async function setAniList(state: 'ok' | 'down'): Promise<void> {
  const response = await fetch('http://127.0.0.1:3200/__mode', {
    method: 'POST',
    body: JSON.stringify({ anilist: state }),
  });
  expect(response.ok).toBe(true);
}

/** Say which episode the mock schedule reports as aired an hour ago (see mock-sources.mjs). */
export async function setAiringEpisode(episode: number): Promise<void> {
  const response = await fetch('http://127.0.0.1:3200/__airing', {
    method: 'POST',
    body: JSON.stringify({ episode }),
  });
  expect(response.ok).toBe(true);
}

/** The one title the mock AniList reports as airing. */
export const SHOW = 'Kusuriya no Hitorigoto 3rd Season';

/** Open the airing show from Discover and add it as Watching. */
export async function watchTheShow(page: Page): Promise<void> {
  await page.goto('/discover?status=releasing');
  await page.getByRole('link', { name: SHOW, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: SHOW })).toBeVisible();
  await page.getByLabel('Status').selectOption('watching');
  await page.getByRole('button', { name: 'Add to library' }).click();
  await expect(page.getByRole('heading', { name: 'On your shelf' })).toBeVisible();
}

const JOBS_CLI = fileURLToPath(new URL('../../api/dist/jobs/cli.js', import.meta.url));

/**
 * Run one of the API's background jobs once, now, the way an operator would (`pnpm jobs:run`):
 * the real airing sync and inbox fan-out against the test database and the mock AniList.
 */
export function runJob(name: 'airing-sync' | 'inbox-fanout'): string {
  const databaseUrl = process.env['E2E_DATABASE_URL'] ?? process.env['DATABASE_URL'];
  if (databaseUrl === undefined) throw new Error('set E2E_DATABASE_URL to run a job');
  return execFileSync(process.execPath, [JOBS_CLI, name], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'development',
      DATABASE_URL: databaseUrl,
      SOURCE_ANILIST_URL: 'http://127.0.0.1:3200/graphql',
      SOURCE_JIKAN_URL: 'http://127.0.0.1:3200/v4',
      SOURCE_TIMEOUT_MS: '3000',
      LOG_LEVEL: 'warn',
    },
  });
}

/** The episode count reads "3 / 25": the 3 is an input you can type in, the rest is text. */
export async function expectCount(page: Page, text: string): Promise<void> {
  const [value, total] = text.split(' / ');
  const count = page.getByTestId('episode-count');
  await expect(count.getByRole('textbox')).toHaveValue(value!);
  await expect(count).toHaveText(`/ ${total}`);
}

/**
 * The web app keeps its access token in memory, so a test that talks to the API itself signs in
 * once more (a separate session) and sends that token.
 */
export async function api(email: string) {
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

/**
 * Make a title's link visible in a list of titles. The seasons of one show are one tile, so a title
 * may be behind it: then the tile is opened and the title is found on the show's page.
 */
export async function showResult(page: Page, name: string): Promise<void> {
  const link = page.getByRole('link', { name, exact: true }).first();
  const tile = page.getByRole('link', { name: /^Franchise / }).first();
  await expect(link.or(tile)).toBeVisible();
  if (!(await link.isVisible())) {
    await tile.click();
    await expect(link).toBeVisible();
  }
}

/** Click a title's link in a list of titles (see {@link showResult}). */
export async function openResult(page: Page, name: string): Promise<void> {
  await showResult(page, name);
  await page.getByRole('link', { name, exact: true }).first().click();
}
