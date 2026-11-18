import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { USER, json, problem, renderApp, signedInHandler, tokens, violations } from './test/render';

/**
 * T10: the auth screens and the signed-in frame, with the real API client over a fake network.
 * Requirement IDs: FR-AUTH-001 (register), -003 (login/session), -004 (logout), -005/-006 (reset,
 * verify); doc 08 §6 (accessibility).
 */

const PASSWORD = 'correct horse battery';

describe('log in (FR-AUTH-003)', () => {
  it('asks for email and password with real labels', async () => {
    renderApp({ route: '/login' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Log in' })).toBeTruthy();
    expect(screen.getByLabelText('Email')).toBeTruthy();
    expect(screen.getByLabelText('Password')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Create an account' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Forgot your password?' })).toBeTruthy();
  });

  it('names the fields that are wrong and moves focus to the message', async () => {
    const app = renderApp({ route: '/login' });
    await app.user.click(await screen.findByRole('button', { name: 'Log in' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Check the highlighted fields.');
    expect(document.activeElement).toBe(alert);
    expect(screen.getByLabelText('Email').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Email must be a valid email address')).toBeTruthy();
    // The request never left: nothing to ask the server about an empty form.
    expect(app.to('/auth/login')).toHaveLength(0);
  });

  it('logs in and lands in the signed-in frame', async () => {
    const app = renderApp({
      route: '/login',
      handler: (call) => {
        if (call.path.endsWith('/auth/refresh')) return problem(401, 'INVALID_REFRESH_TOKEN');
        if (call.path.endsWith('/auth/login')) return json(200, { ...tokens(), user: USER });
        return problem(404, 'NOT_FOUND');
      },
    });
    await app.user.type(await screen.findByLabelText('Email'), USER.email);
    await app.user.type(screen.getByLabelText('Password'), PASSWORD);
    await app.user.click(screen.getByRole('button', { name: 'Log in' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Welcome, Reader' })).toBeTruthy();
    expect(app.to('/auth/login')[0]?.body).toEqual({ email: USER.email, password: PASSWORD });
    expect(screen.getByTestId('account-name').textContent).toBe('Reader');
  });

  it('says the email or password is wrong without saying which', async () => {
    const app = renderApp({
      route: '/login',
      handler: (call) =>
        call.path.endsWith('/auth/login')
          ? problem(401, 'INVALID_CREDENTIALS')
          : problem(401, 'INVALID_REFRESH_TOKEN'),
    });
    await app.user.type(await screen.findByLabelText('Email'), USER.email);
    await app.user.type(screen.getByLabelText('Password'), 'nope');
    await app.user.click(screen.getByRole('button', { name: 'Log in' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The email or password is incorrect.',
    );
  });

  it('tells the user how long to wait when rate limited', async () => {
    const app = renderApp({
      route: '/login',
      handler: (call) =>
        call.path.endsWith('/auth/login')
          ? problem(429, 'RATE_LIMITED', {}, { 'Retry-After': '30' })
          : problem(401, 'INVALID_REFRESH_TOKEN'),
    });
    await app.user.type(await screen.findByLabelText('Email'), USER.email);
    await app.user.type(screen.getByLabelText('Password'), PASSWORD);
    await app.user.click(screen.getByRole('button', { name: 'Log in' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Too many attempts. Try again in 30 seconds.',
    );
  });

  it('says so when the server cannot be reached', async () => {
    const app = renderApp({
      route: '/login',
      handler: (call) => {
        if (call.path.endsWith('/auth/login')) throw new TypeError('offline');
        return problem(401, 'INVALID_REFRESH_TOKEN');
      },
    });
    await app.user.type(await screen.findByLabelText('Email'), USER.email);
    await app.user.type(screen.getByLabelText('Password'), PASSWORD);
    await app.user.click(screen.getByRole('button', { name: 'Log in' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Cannot reach the server/);
  });

  it('skips the screen for someone who is already signed in', async () => {
    renderApp({ route: '/login', handler: signedInHandler() });
    expect(await screen.findByRole('heading', { level: 1, name: 'Welcome, Reader' })).toBeTruthy();
  });

  it('is free of automatically detectable accessibility problems', async () => {
    const app = renderApp({ route: '/login' });
    await screen.findByRole('heading', { name: 'Log in' });
    expect(await violations(app.container)).toEqual([]);
  });
});

describe('create an account (FR-AUTH-001)', () => {
  it('validates with the same rules as the server before asking it', async () => {
    const app = renderApp({ route: '/register' });
    await app.user.type(await screen.findByLabelText('Name'), 'A');
    await app.user.type(screen.getByLabelText('Email'), 'a@example.test');
    await app.user.type(screen.getByLabelText('Password'), 'short');
    await app.user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Password must be at least 10 characters')).toBeTruthy();
    expect(app.to('/auth/register')).toHaveLength(0);
  });

  it('registers and asks the user to check their email', async () => {
    const app = renderApp({
      route: '/register',
      handler: (call) =>
        call.path.endsWith('/auth/register')
          ? json(201, { status: 'verification_pending' })
          : problem(401, 'INVALID_REFRESH_TOKEN'),
    });
    await app.user.type(await screen.findByLabelText('Name'), 'Reader');
    await app.user.type(screen.getByLabelText('Email'), 'new@example.test');
    await app.user.type(screen.getByLabelText('Password'), PASSWORD);
    await app.user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('new@example.test');
    expect(app.to('/auth/register')[0]?.body).toEqual({
      email: 'new@example.test',
      password: PASSWORD,
      displayName: 'Reader',
    });
  });

  it("shows the server's verdict on a field (for example a breached password)", async () => {
    const app = renderApp({
      route: '/register',
      handler: (call) =>
        call.path.endsWith('/auth/register')
          ? problem(422, 'VALIDATION_ERROR', {
              errors: [{ path: 'password', message: 'is too common' }],
            })
          : problem(401, 'INVALID_REFRESH_TOKEN'),
    });
    await app.user.type(await screen.findByLabelText('Name'), 'Reader');
    await app.user.type(screen.getByLabelText('Email'), 'new@example.test');
    await app.user.type(screen.getByLabelText('Password'), 'password123456');
    await app.user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Password is too common')).toBeTruthy();
  });

  it('is free of automatically detectable accessibility problems', async () => {
    const app = renderApp({ route: '/register' });
    await screen.findByRole('heading', { name: 'Create an account' });
    expect(await violations(app.container)).toEqual([]);
  });
});

describe('verify email (FR-AUTH-006)', () => {
  it('spends the link once (even when React runs the effect twice) and says it worked', async () => {
    const app = renderApp({
      route: '/verify-email#token=abc123',
      handler: (call) =>
        call.path.endsWith('/auth/verify-email')
          ? json(200, { status: 'verified' })
          : problem(401, 'INVALID_REFRESH_TOKEN'),
    });
    expect(await screen.findByText('Your email address is verified.')).toBeTruthy();
    expect(app.to('/auth/verify-email')).toHaveLength(1);
    expect(app.to('/auth/verify-email')[0]?.body).toEqual({ token: 'abc123' });
    expect(screen.getByRole('link', { name: 'Log in' })).toBeTruthy();
  });

  it('explains a dead link in plain words', async () => {
    renderApp({
      route: '/verify-email#token=old',
      handler: (call) =>
        call.path.endsWith('/auth/verify-email')
          ? problem(400, 'INVALID_TOKEN')
          : problem(401, 'INVALID_REFRESH_TOKEN'),
    });
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /invalid, has expired or was already used/,
    );
  });

  it('does not call the server for a link with no token', async () => {
    const app = renderApp({ route: '/verify-email' });
    expect(await screen.findByText(/This link is incomplete/)).toBeTruthy();
    expect(app.to('/auth/verify-email')).toHaveLength(0);
  });
});

describe('reset password (FR-AUTH-005)', () => {
  it('forgot-password gives the same answer for any address', async () => {
    const app = renderApp({
      route: '/forgot-password',
      handler: (call) =>
        call.path.endsWith('/auth/password/forgot')
          ? json(202, { status: 'accepted' })
          : problem(401, 'INVALID_REFRESH_TOKEN'),
    });
    await app.user.type(await screen.findByLabelText('Email'), 'nobody@example.test');
    await app.user.click(screen.getByRole('button', { name: 'Send link' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/If an account exists/);
  });

  it('refuses a mismatched confirmation before asking the server', async () => {
    const app = renderApp({ route: '/reset-password#token=tok' });
    await app.user.type(await screen.findByLabelText('New password'), 'a brand new passphrase');
    await app.user.type(
      screen.getByLabelText('Repeat the new password'),
      'something else entirely',
    );
    await app.user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('The two passwords do not match.')).toBeTruthy();
    expect(app.to('/auth/password/reset')).toHaveLength(0);
  });

  it('resets, then points to log in', async () => {
    const app = renderApp({
      route: '/reset-password#token=tok',
      handler: (call) =>
        call.path.endsWith('/auth/password/reset')
          ? json(200, { status: 'password_reset' })
          : problem(401, 'INVALID_REFRESH_TOKEN'),
    });
    await app.user.type(await screen.findByLabelText('New password'), 'a brand new passphrase');
    await app.user.type(screen.getByLabelText('Repeat the new password'), 'a brand new passphrase');
    await app.user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByRole('heading', { name: 'Password changed' })).toBeTruthy();
    expect(app.to('/auth/password/reset')[0]?.body).toEqual({
      token: 'tok',
      newPassword: 'a brand new passphrase',
    });
  });

  it('asks for a new link when this one has no token', async () => {
    renderApp({ route: '/reset-password' });
    expect(await screen.findByRole('link', { name: 'Request a new link' })).toBeTruthy();
  });

  it('is free of automatically detectable accessibility problems', async () => {
    const app = renderApp({ route: '/reset-password#token=tok' });
    await screen.findByRole('heading', { name: 'Choose a new password' });
    expect(await violations(app.container)).toEqual([]);
  });
});

describe('the signed-in frame (doc 08 §4)', () => {
  it('sends a visitor who is not signed in to log in', async () => {
    renderApp({ route: '/' });
    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeTruthy();
  });

  it('has a skip link, a labelled main navigation and the account controls', async () => {
    const app = renderApp({ route: '/', handler: signedInHandler() });
    await screen.findByRole('heading', { name: 'Welcome, Reader' });
    expect(screen.getByRole('link', { name: 'Skip to content' }).getAttribute('href')).toBe(
      '#main',
    );
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Home' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.getByRole('button', { name: 'Log out' })).toBeTruthy();
    expect(await violations(app.container)).toEqual([]);
  });

  it('shows a banner to an unverified user and can resend the link', async () => {
    const app = renderApp({
      route: '/',
      handler: signedInHandler({ emailVerified: false }, (call) =>
        call.path.endsWith('/verify-email/resend')
          ? json(202, { status: 'accepted' })
          : problem(404, 'NOT_FOUND'),
      ),
    });
    await screen.findByText(/Verify your email address/);
    await app.user.click(screen.getByRole('button', { name: 'Send the link again' }));
    expect(await screen.findByText('A new link is on its way.')).toBeTruthy();
    expect(app.to('/verify-email/resend')).toHaveLength(1);
  });

  it('shows no banner once verified', async () => {
    renderApp({ route: '/', handler: signedInHandler() });
    await screen.findByRole('heading', { name: 'Welcome, Reader' });
    expect(screen.queryByText(/Verify your email address/)).toBeNull();
  });

  it('logs out and returns to the log-in screen', async () => {
    const app = renderApp({
      route: '/',
      handler: signedInHandler({}, (call) =>
        call.path.endsWith('/auth/logout')
          ? new Response(null, { status: 204 })
          : problem(404, 'NOT_FOUND'),
      ),
    });
    await app.user.click(await screen.findByRole('button', { name: 'Log out' }));
    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeTruthy();
    expect(app.to('/auth/logout')).toHaveLength(1);
    await waitFor(() => {
      expect(app.client.isSignedIn()).toBe(false);
    });
  });

  it('shows a page-not-found screen for an unknown address', async () => {
    renderApp({ route: '/nope' });
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
  });
});
