import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { emailedLink } from './mail';

/**
 * T10 journeys: sign up (the "email" is read from the API's dev output) → verify → log in →
 * the signed-in frame → log out, plus password reset and accessibility in a real browser, where
 * colour contrast can be measured.
 */

const unique = (label: string) =>
  `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
const PASSWORD = 'correct horse battery staple';

async function signUp(page: Page, email: string, name = 'Hana'): Promise<void> {
  await page.goto('/register');
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
}

async function logIn(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
}

test('journey 1: sign up, verify, log in, see the shell, log out', async ({ page }) => {
  const email = unique('journey');
  await signUp(page, email);

  // The emailed link verifies the address; the token never stays in the address bar.
  await page.goto(await emailedLink(email, 'verify'));
  await expect(page.getByText('Your email address is verified.')).toBeVisible();
  expect(page.url()).not.toContain('token');

  await page.getByRole('link', { name: 'Log in' }).click();
  await logIn(page, email);
  await expect(page.getByRole('heading', { name: 'Welcome, Hana' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expect(page.getByText(/Verify your email address/)).toHaveCount(0);

  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
  // Logged out for real: the frame is closed to this browser now.
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
});

test('an unverified user can log in and is nudged to verify', async ({ page }) => {
  const email = unique('unverified');
  await signUp(page, email);
  await logIn(page, email);
  await expect(page.getByRole('heading', { name: 'Welcome, Hana' })).toBeVisible();
  await expect(page.getByText(/Verify your email address/)).toBeVisible();
});

test('a reload keeps the session (the refresh cookie restores it)', async ({ page }) => {
  const email = unique('reload');
  await signUp(page, email);
  await logIn(page, email);
  await expect(page.getByRole('heading', { name: 'Welcome, Hana' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Welcome, Hana' })).toBeVisible();
});

test('a wrong password is refused with a plain message', async ({ page }) => {
  const email = unique('wrong');
  await signUp(page, email);
  await logIn(page, email, 'definitely not the password');
  await expect(page.getByRole('alert')).toHaveText('The email or password is incorrect.');
  await expect(page).toHaveURL(/\/login$/);
});

test('forgot and reset password: the old password stops working, the new one works', async ({
  page,
}) => {
  const email = unique('reset');
  await signUp(page, email);

  await page.goto('/forgot-password');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Send link' }).click();
  await expect(page.getByText(/If an account exists/)).toBeVisible();

  await page.goto(await emailedLink(email, 'reset'));
  await page.getByLabel('New password', { exact: true }).fill('a brand new passphrase 7');
  await page.getByLabel('Repeat the new password').fill('a brand new passphrase 7');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByRole('heading', { name: 'Password changed' })).toBeVisible();

  await logIn(page, email);
  await expect(page.getByRole('alert')).toHaveText('The email or password is incorrect.');
  await logIn(page, email, 'a brand new passphrase 7');
  await expect(page.getByRole('heading', { name: 'Welcome, Hana' })).toBeVisible();
});

for (const scheme of ['light', 'dark'] as const) {
  test(`accessibility (WCAG 2.2 AA, ${scheme}): auth screens and the shell have no axe violations`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const email = unique(`axe-${scheme}`);
    await signUp(page, email);

    const check = async (label: string) => {
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(
        results.violations.map((v) => `${label}: ${v.id} ${v.help} (${v.nodes.length})`),
      ).toEqual([]);
    };

    for (const path of ['/login', '/register', '/forgot-password']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await check(path);
    }
    // An error state is part of the screen too.
    await page.goto('/login');
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await check('/login (errors)');

    await logIn(page, email);
    await expect(page.getByRole('heading', { name: 'Welcome, Hana' })).toBeVisible();
    await check('/ (signed in, unverified banner)');
  });
}

test('mobile width: the top bar replaces the sidebar and nothing scrolls sideways', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const email = unique('mobile');
  await signUp(page, email);
  await logIn(page, email);
  await expect(page.getByRole('heading', { name: 'Welcome, Hana' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('the Content-Security-Policy is in force and the app breaks none of it', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (message) => {
    // A visitor with no session gets a 401 when the app tries to restore one: expected, and the
    // browser logs every failed request. Anything else (a 404, a script error) is a problem.
    const expected = message.text().includes('status of 401');
    if (message.type() === 'error' && !expected) problems.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      console.error(`CSP violation: ${event.violatedDirective} ${event.blockedURI}`);
    });
  });

  await page.goto('/login');
  const policy = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content');
  expect(policy).toContain("script-src 'self'");
  expect(policy).toContain("object-src 'none'");

  const email = unique('csp');
  await signUp(page, email);
  await logIn(page, email);
  await expect(page.getByRole('heading', { name: 'Welcome, Hana' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Welcome, Hana' })).toBeVisible();
  expect(problems).toEqual([]);
});

test('no token is kept in browser storage (doc 09 S-AUTH-7)', async ({ page }) => {
  const email = unique('storage');
  await signUp(page, email);
  await logIn(page, email);
  await expect(page.getByRole('heading', { name: 'Welcome, Hana' })).toBeVisible();
  const stored = await page.evaluate(() => ({
    local: JSON.stringify({ ...localStorage }),
    session: JSON.stringify({ ...sessionStorage }),
    cookies: document.cookie,
  }));
  expect(stored).toEqual({ local: '{}', session: '{}', cookies: '' }); // the refresh cookie is HttpOnly
  const cookies = await page.context().cookies();
  const refresh = cookies.find((cookie) => cookie.name === 'akiba_refresh');
  expect(refresh).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/v1/auth' });
});
