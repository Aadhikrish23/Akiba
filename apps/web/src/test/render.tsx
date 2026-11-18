import { createApiClient, type ApiClient } from '@akiba/api-client';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router';
import { AppRoutes } from '../App';
import { AuthProvider } from '../auth/AuthContext';
import { ApiProvider } from '../lib/api';

export const USER = {
  id: '3f2b8c1e-5a47-4d0e-9d57-0c5d9a3b7e11',
  email: 'reader@example.test',
  displayName: 'Reader',
  emailVerified: true,
};

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

export const problem = (
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) =>
  json(
    status,
    {
      type: `https://akiba.example/errors/${code.toLowerCase()}`,
      title: code,
      status,
      code,
      detail: `${code} happened`,
      requestId: 'req-1',
      ...extra,
    },
    headers,
  );

export const tokens = (accessToken = 'access-1') => ({
  accessToken,
  tokenType: 'Bearer',
  expiresIn: 900,
});

export interface Call {
  readonly method: string;
  readonly path: string;
  /** The query string including the leading `?`, or empty. */
  readonly search: string;
  readonly body: unknown;
}

type Handler = (call: Call) => Response | Promise<Response>;

export interface Harness {
  readonly client: ApiClient;
  readonly calls: Call[];
  readonly user: ReturnType<typeof userEvent.setup>;
  readonly container: HTMLElement;
  /** Calls whose path ends with `suffix`. */
  to(suffix: string): Call[];
}

/**
 * The real app, the real API client, a fake network. By default nobody is signed in (the session
 * restore is refused, like a browser with no cookie); pass `handler` to script the server.
 */
export function renderApp(
  options: { route?: string; handler?: Handler; strict?: boolean } = {},
): Harness {
  const calls: Call[] = [];
  const handler: Handler =
    options.handler ??
    ((call) =>
      call.path.endsWith('/auth/refresh')
        ? problem(401, 'INVALID_REFRESH_TOKEN')
        : problem(404, 'NOT_FOUND'));
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      search: url.search,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    };
    calls.push(call);
    return handler(call);
  };
  const client = createApiClient({
    baseUrl: 'https://akiba.example.test/v1',
    platform: 'web',
    fetch: fetchImpl,
  });
  const tree = (
    <ApiProvider client={client}>
      <AuthProvider>
        <MemoryRouter initialEntries={[options.route ?? '/login']}>
          <AppRoutes />
        </MemoryRouter>
      </AuthProvider>
    </ApiProvider>
  );
  const { container } = render(options.strict === false ? tree : <StrictMode>{tree}</StrictMode>);
  return {
    client,
    calls,
    user: userEvent.setup(),
    container,
    to: (suffix) => calls.filter((call) => call.path.endsWith(suffix)),
  };
}

/** A server where this user's session is alive: the restore works and /me answers. */
export function signedInHandler(
  overrides: Partial<typeof USER> = {},
  extra: Handler = () => problem(404, 'NOT_FOUND'),
): Handler {
  return (call) => {
    if (call.path.endsWith('/auth/refresh')) return json(200, tokens());
    if (call.path.endsWith('/me')) return json(200, { ...USER, ...overrides });
    return extra(call);
  };
}

/** WCAG checks axe can do without layout (jsdom has none, so colour contrast is checked in the browser test). */
export async function violations(container: HTMLElement): Promise<string[]> {
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });
  return results.violations.map((violation) => `${violation.id}: ${violation.help}`);
}
