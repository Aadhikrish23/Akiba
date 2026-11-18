import { userEvent } from '@testing-library/react-native';
import { renderRouter, screen } from 'expo-router/testing-library';
import { secureStore } from './setup';

export const USER = {
  id: '3f2b8c1e-5a47-4d0e-9d57-0c5d9a3b7e11',
  email: 'reader@example.test',
  displayName: 'Reader',
  emailVerified: true,
  titleLanguage: 'romaji',
  timeZone: 'UTC',
  libraryView: 'grid',
  alertsEnabled: true,
  showAdult: false,
  createdAt: '2026-11-01T00:00:00.000Z',
};

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

export const problem = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  json(status, {
    type: `https://akiba.example/errors/${code.toLowerCase()}`,
    title: code,
    status,
    code,
    detail: `${code} happened`,
    requestId: 'req-1',
    ...extra,
  });

/** What login and refresh answer with: a short-lived access token and a rotating refresh token. */
export const tokens = (refreshToken = 'R'.repeat(43), accessToken = 'access-1') => ({
  accessToken,
  refreshToken,
  tokenType: 'Bearer',
  expiresIn: 900,
});

export interface Call {
  readonly method: string;
  readonly path: string;
  /** The query string including the leading `?`, or empty. */
  readonly search: string;
  readonly body: unknown;
  readonly headers: Record<string, string>;
}

export type Handler = (call: Call) => Response | Promise<Response>;

/** The key the app keeps its refresh token under (see lib/secureStorage.ts). */
export const REFRESH_KEY = 'akiba.refresh-token';

/**
 * The real app, the real API client, a fake network. By default nobody is signed in (the session
 * restore is refused, like a phone with no stored session); pass `handler` to script the server and
 * `storedRefreshToken` to start with a session on the device.
 */
export async function renderApp(
  options: { route?: string; handler?: Handler; storedRefreshToken?: string } = {},
) {
  const calls: Call[] = [];
  const handler: Handler =
    options.handler ??
    ((call) =>
      call.path.endsWith('/auth/refresh')
        ? problem(401, 'INVALID_REFRESH_TOKEN')
        : problem(404, 'NOT_FOUND'));
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      search: url.search,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    };
    calls.push(call);
    return handler(call);
  };
  if (options.storedRefreshToken !== undefined) {
    secureStore.set(REFRESH_KEY, options.storedRefreshToken);
  }
  await renderRouter('./src/app', { initialUrl: options.route ?? '/' });
  return {
    calls,
    user: userEvent.setup(),
    to: (suffix: string) => calls.filter((call) => call.path.endsWith(suffix)),
  };
}

/** A server where this user's session is alive: the restore works and /me answers. */
export function signedInHandler(
  extra: Handler = () => problem(404, 'NOT_FOUND'),
  overrides: Partial<typeof USER> = {},
): Handler {
  return (call) => {
    if (call.path.endsWith('/auth/refresh')) return json(200, tokens());
    if (call.method === 'GET' && call.path.endsWith('/me'))
      return json(200, { ...USER, ...overrides });
    if (call.method === 'POST' && call.path.endsWith('/auth/logout')) return json(200, {});
    return extra(call);
  };
}

export { screen };

/** A tab of the bar: React Navigation names it "Home, tab, 1 of 5" and exposes it as a button. */
export const tab = (name: string) =>
  screen.getByRole('button', { name: new RegExp(`^${name}, tab, [0-9] of 5$`) });
