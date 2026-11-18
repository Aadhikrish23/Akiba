import { expect, type Page } from '@playwright/test';

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
