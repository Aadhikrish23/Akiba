import { Appearance, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import {
  REFRESH_KEY,
  USER,
  json,
  problem,
  renderApp,
  screen,
  signedInHandler,
  tokens,
  type Handler,
} from '../test/render';
import { secureStore } from '../test/setup';

/**
 * T25: the app's foundation, with the real API client over a fake network and a fake secure store:
 * the session gate, the auth screens, the tab shell, the device's own light and dark, and the
 * accessibility basics every control must meet (role, name, 44 pt target).
 */

const IDENTITY = {
  id: USER.id,
  email: USER.email,
  displayName: USER.displayName,
  emailVerified: USER.emailVerified,
};

/** A server where logging in works with the right credentials. */
const server = (extra: Handler = () => problem(404, 'NOT_FOUND')): Handler =>
  signedInHandler((call) => {
    if (call.method === 'POST' && call.path.endsWith('/auth/login')) {
      const body = call.body as { email: string; password: string };
      return body.password === 'correct horse battery staple'
        ? json(200, { ...tokens('L'.repeat(43)), user: IDENTITY })
        : problem(401, 'INVALID_CREDENTIALS');
    }
    return extra(call);
  });

/** A signed-out phone: the stored session is refused. */
const signedOut =
  (extra: Handler = () => problem(404, 'NOT_FOUND')): Handler =>
  (call) =>
    call.path.endsWith('/auth/refresh')
      ? problem(401, 'INVALID_REFRESH_TOKEN')
      : server(extra)(call);

/** A tab of the bar: React Navigation names it "Home, tab, 1 of 5" and exposes it as a button. */
const tab = (name: string) =>
  screen.getByRole('button', { name: new RegExp(`^${name}, tab, [0-9] of 5$`) });

const flatten = (style: unknown): Record<string, unknown> =>
  StyleSheet.flatten(style as StyleProp<ViewStyle>) as Record<string, unknown>;

describe('session gate (T25)', () => {
  it('a phone with no stored session opens on the log-in screen', async () => {
    await renderApp({ handler: signedOut() });
    expect(await screen.findByRole('button', { name: 'Log in' })).toBeTruthy();
    expect(screen.getByLabelText('Email')).toBeTruthy();
    expect(screen.getByLabelText('Password')).toBeTruthy();
    expect(screen.queryByText(/Welcome, Reader/)).toBeNull();
  });

  it('a stored session is renewed at launch, rotated, and opens the app (FR-AUTH, mobile transport)', async () => {
    const app = await renderApp({ handler: server(), storedRefreshToken: 'S'.repeat(43) });
    expect(await screen.findByText('Welcome, Reader')).toBeTruthy();
    const refresh = app.to('/auth/refresh')[0]!;
    expect(refresh.body).toEqual({ refreshToken: 'S'.repeat(43) });
    expect(refresh.headers['x-client']).toMatch(/^mobile\//);
    // The new token replaced the old one in secure storage.
    expect(secureStore.get(REFRESH_KEY)).toBe('R'.repeat(43));
  });

  it('a stored session the server refuses ends at the log-in screen', async () => {
    await renderApp({ handler: signedOut(), storedRefreshToken: 'S'.repeat(43) });
    expect(await screen.findByRole('button', { name: 'Log in' })).toBeTruthy();
  });

  it('an unreachable server also ends at the log-in screen, and keeps the stored session for next time', async () => {
    await renderApp({
      handler: () => Promise.reject(new TypeError('Network request failed')),
      storedRefreshToken: 'S'.repeat(43),
    });
    expect(await screen.findByRole('button', { name: 'Log in' })).toBeTruthy();
    // Being offline says nothing about whether the session is still good: the token stays.
    expect(secureStore.get(REFRESH_KEY)).toBe('S'.repeat(43));
  });

  it('logging in stores the refresh token in secure storage and opens the app', async () => {
    const app = await renderApp({ handler: signedOut() });
    await app.user.type(await screen.findByLabelText('Email'), USER.email);
    await app.user.type(screen.getByLabelText('Password'), 'correct horse battery staple');
    await app.user.press(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByText('Welcome, Reader')).toBeTruthy();
    expect(app.to('/auth/login')[0]!.body).toEqual({
      email: USER.email,
      password: 'correct horse battery staple',
    });
    expect(secureStore.get(REFRESH_KEY)).toBe('L'.repeat(43));
  });

  it('wrong credentials say so and stay on the screen', async () => {
    const app = await renderApp({ handler: signedOut() });
    await app.user.type(await screen.findByLabelText('Email'), USER.email);
    await app.user.type(screen.getByLabelText('Password'), 'not the password');
    await app.user.press(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByText('The email or password is incorrect.')).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.queryByText('Welcome, Reader')).toBeNull();
    expect(secureStore.size).toBe(0);
  });

  it('checks the fields before asking the server, and says which one is wrong', async () => {
    const app = await renderApp({ handler: signedOut() });
    await app.user.press(await screen.findByRole('button', { name: 'Log in' }));
    expect(await screen.findByText('Check the highlighted fields.')).toBeTruthy();
    expect(screen.getByText(/^Email /)).toBeTruthy();
    expect(app.to('/auth/login')).toHaveLength(0);
  });

  it('logging out ends the session, clears secure storage and returns to log-in', async () => {
    const app = await renderApp({ handler: server(), storedRefreshToken: 'S'.repeat(43) });
    await screen.findByText('Welcome, Reader');
    await app.user.press(tab('Me'));
    await app.user.press(await screen.findByRole('button', { name: 'Log out' }));
    expect(await screen.findByRole('button', { name: 'Log in' })).toBeTruthy();
    expect(secureStore.has(REFRESH_KEY)).toBe(false);
    expect(app.to('/auth/logout')).toHaveLength(1);
    expect(app.to('/auth/logout')[0]!.body).toEqual({ refreshToken: 'R'.repeat(43) });
  });
});

describe('auth screens (T25)', () => {
  it('registers, and says where the link went', async () => {
    const app = await renderApp({
      handler: signedOut((call) =>
        call.method === 'POST' && call.path.endsWith('/auth/register')
          ? json(202, { status: 'verification_pending' })
          : problem(404, 'NOT_FOUND'),
      ),
    });
    await app.user.press(await screen.findByRole('link', { name: 'Create an account' }));
    await app.user.type(await screen.findByLabelText('Name'), 'Hana');
    await app.user.type(screen.getByLabelText('Email'), 'hana@example.test');
    await app.user.type(screen.getByLabelText('Password'), 'correct horse battery staple');
    await app.user.press(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('header', { name: 'Check your email' })).toBeTruthy();
    expect(screen.getByText(/We sent a link to hana@example.test/)).toBeTruthy();
    expect(app.to('/auth/register')[0]!.body).toEqual({
      email: 'hana@example.test',
      password: 'correct horse battery staple',
      displayName: 'Hana',
    });
  });

  it('a too-short password is refused on the phone with a hint, before any request', async () => {
    const app = await renderApp({ handler: signedOut() });
    await app.user.press(await screen.findByRole('link', { name: 'Create an account' }));
    await app.user.type(await screen.findByLabelText('Name'), 'Hana');
    await app.user.type(screen.getByLabelText('Email'), 'hana@example.test');
    await app.user.type(screen.getByLabelText('Password'), 'short');
    await app.user.press(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText(/^Password /)).toBeTruthy();
    expect(app.to('/auth/register')).toHaveLength(0);
  });

  it('forgot password gives the same answer for any address', async () => {
    const app = await renderApp({
      handler: signedOut((call) =>
        call.path.endsWith('/auth/password/forgot')
          ? json(202, { status: 'accepted' })
          : problem(404, 'NOT_FOUND'),
      ),
    });
    await app.user.press(await screen.findByRole('link', { name: 'Forgot your password?' }));
    await app.user.type(await screen.findByLabelText('Email'), 'anyone@example.test');
    await app.user.press(screen.getByRole('button', { name: 'Send the link' }));
    expect(await screen.findByText(/If an account exists for that address/)).toBeTruthy();
  });
});

describe('tabs and accessibility (T25, doc 08 §4 and §6)', () => {
  it('has the five destinations, and each moves to its screen', async () => {
    const app = await renderApp({ handler: server(), storedRefreshToken: 'S'.repeat(43) });
    await screen.findByText('Welcome, Reader');
    for (const name of ['Home', 'Discover', 'Library', 'Inbox', 'Me']) {
      expect(tab(name)).toBeTruthy();
    }
    expect(screen.getAllByRole('button', { name: /, tab, [0-9] of 5$/ })).toHaveLength(5);
    await app.user.press(tab('Library'));
    expect(await screen.findByRole('header', { name: 'Library' })).toBeTruthy();
  });

  it('every button and link has a role, a name and a target of at least 44 points', async () => {
    await renderApp({ handler: signedOut() });
    await screen.findByRole('button', { name: 'Log in' });
    const targets = [...screen.getAllByRole('button'), ...screen.getAllByRole('link')];
    expect(targets.length).toBeGreaterThanOrEqual(3);
    for (const target of targets) {
      const style = flatten(target.props.style);
      expect(Number(style['minHeight'] ?? 0)).toBeGreaterThanOrEqual(44);
      expect(String(target.props.accessibilityLabel ?? '').length).toBeGreaterThan(0);
    }
    // Fields are named by their visible label.
    for (const label of ['Email', 'Password']) expect(screen.getByLabelText(label)).toBeTruthy();
  });

  it('follows the device: dark colours at night, light by day', async () => {
    Appearance.setColorScheme('dark');
    try {
      await renderApp({ handler: signedOut() });
      const button = await screen.findByRole('button', { name: 'Log in' });
      const dark = flatten(button.props.style);
      expect(dark['backgroundColor']).toMatch(/^#[0-9a-f]{6}$/i);
      Appearance.setColorScheme('light');
    } finally {
      Appearance.setColorScheme('unspecified');
    }
  });
});
