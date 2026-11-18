import { describe, expect, it } from 'vitest';
import {
  ApiError,
  ContractError,
  NetworkError,
  NotSignedInError,
  createApiClient,
  type ApiClientOptions,
  type AuthEvent,
  type RefreshTokenStorage,
} from './index.js';

const USER = {
  id: '3f2b8c1e-5a47-4d0e-9d57-0c5d9a3b7e11',
  email: 'reader@example.test',
  displayName: 'Reader',
  emailVerified: true,
  // The settings `GET /me` adds to the identity.
  titleLanguage: 'romaji',
  timeZone: 'UTC',
  libraryView: 'grid',
  alertsEnabled: true,
  showAdult: false,
  createdAt: '2026-11-01T00:00:00.000Z',
};
/** What login returns: identity only. */
const IDENTITY = {
  id: USER.id,
  email: USER.email,
  displayName: USER.displayName,
  emailVerified: USER.emailVerified,
};
const REFRESH_A = 'A'.repeat(43);
const REFRESH_B = 'B'.repeat(43);
const REFRESH_C = 'C'.repeat(43);

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  readonly credentials: RequestCredentials | undefined;
}

type Handler = (request: Recorded, index: number) => Response | Promise<Response>;

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const problem = (status: number, code: string, extra: Record<string, unknown> = {}): Response =>
  json(status, {
    type: `https://akiba.example/errors/${code.toLowerCase()}`,
    title: code,
    status,
    code,
    detail: `${code} happened`,
    requestId: 'req-1',
    ...extra,
  });

const tokens = (accessToken: string, refreshToken?: string, expiresIn = 900) => ({
  accessToken,
  tokenType: 'Bearer',
  expiresIn,
  ...(refreshToken === undefined ? {} : { refreshToken }),
});

function setup(handler: Handler, options: Partial<ApiClientOptions> = {}) {
  const calls: Recorded[] = [];
  let nowMs = 1_000_000;
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    const recorded: Recorded = {
      url: input instanceof Request ? input.url : input.toString(),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(headers.entries()),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      credentials: init?.credentials,
    };
    calls.push(recorded);
    return handler(recorded, calls.length - 1);
  };
  const client = createApiClient({
    baseUrl: 'https://api.example.test/v1',
    platform: 'web',
    fetch: fetchImpl,
    now: () => nowMs,
    ...options,
  });
  const events: AuthEvent[] = [];
  client.onAuthChange((event) => events.push(event));
  return {
    client,
    calls,
    events,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

const memoryStorage = (initial?: string): RefreshTokenStorage & { value: string | undefined } => {
  const storage = {
    value: initial,
    get: () => storage.value,
    set: (token: string | undefined) => {
      storage.value = token;
    },
  };
  return storage;
};

describe('@akiba/api-client: construction', () => {
  it('identifies itself using the shared app name', () => {
    const client = createApiClient({ baseUrl: 'https://api.example.test', platform: 'web' });
    expect(client.clientName).toBe('Akiba/web');
    expect(client.platform).toBe('web');
  });

  it.each([
    ['https://api.example.test', '/titles', 'https://api.example.test/titles'],
    ['https://api.example.test/', 'titles', 'https://api.example.test/titles'],
    ['https://api.example.test/v1/', '/titles', 'https://api.example.test/v1/titles'],
  ])('resolves %s + %s', (baseUrl, path, expected) => {
    expect(createApiClient({ baseUrl, platform: 'mobile' }).url(path)).toBe(expected);
  });

  it('rejects a base URL that is not absolute', () => {
    expect(() => createApiClient({ baseUrl: '/api', platform: 'web' })).toThrow(TypeError);
  });

  it('rejects a client version the API would not accept', () => {
    expect(() =>
      createApiClient({
        baseUrl: 'https://api.example.test',
        platform: 'web',
        clientVersion: 'not valid!',
      }),
    ).toThrow(TypeError);
  });
});

describe('@akiba/api-client: requests', () => {
  it('names the client in X-Client and asks for JSON', async () => {
    const { client, calls } = setup(() => json(200, { status: 'verification_pending' }), {
      clientVersion: '1.4.0',
    });
    await client.auth.register({
      email: 'a@example.test',
      password: 'correct horse battery',
      displayName: 'A',
    });
    expect(calls[0]?.url).toBe('https://api.example.test/v1/auth/register');
    expect(calls[0]?.headers['x-client']).toBe('web/1.4.0');
    expect(calls[0]?.headers['accept']).toBe('application/json');
    expect(calls[0]?.headers['content-type']).toBe('application/json');
    expect(calls[0]?.headers['authorization']).toBeUndefined();
  });

  it('sends cookies for web and desktop, never for mobile', async () => {
    for (const [platform, expected] of [
      ['web', 'include'],
      ['desktop', 'include'],
      ['mobile', 'omit'],
    ] as const) {
      const { client, calls } = setup(() => json(200, { status: 'ok' }), { platform });
      await client.health();
      expect(calls[0]?.credentials, platform).toBe(expected);
    }
  });

  it('reaches /health and /ready at the API origin, outside /v1', async () => {
    const { client, calls } = setup((request) =>
      request.url.endsWith('/health')
        ? json(200, { status: 'ok' })
        : json(200, { status: 'ready', checks: { database: 'ok', sources: 'not_configured' } }),
    );
    await expect(client.health()).resolves.toEqual({ status: 'ok' });
    await expect(client.ready()).resolves.toMatchObject({ status: 'ready' });
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.example.test/health',
      'https://api.example.test/ready',
    ]);
  });

  it('turns a 503 from /ready into an ApiError coded NOT_READY', async () => {
    const { client } = setup(() =>
      problem(503, 'NOT_READY', { checks: { database: 'unavailable' } }),
    );
    await expect(client.ready()).rejects.toMatchObject({ status: 503, code: 'NOT_READY' });
  });
});

describe('@akiba/api-client: errors', () => {
  it('maps a problem document onto ApiError, including field errors and Retry-After', async () => {
    const { client } = setup(() =>
      json(
        422,
        {
          type: 'https://akiba.example/errors/validation',
          title: 'Validation failed',
          status: 422,
          code: 'VALIDATION_ERROR',
          detail: 'Bad input',
          errors: [{ path: 'email', message: 'must be a valid email address' }],
          requestId: 'req-9',
        },
        { 'Retry-After': '7' },
      ),
    );
    const error = await client.auth
      .forgotPassword({ email: 'nope' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 422,
      code: 'VALIDATION_ERROR',
      requestId: 'req-9',
      retryAfterSeconds: 7,
      errors: [{ path: 'email', message: 'must be a valid email address' }],
    });
  });

  it('synthesises an ApiError when the error body is not a problem document', async () => {
    const { client } = setup(() => new Response('<html>Bad gateway</html>', { status: 502 }));
    await expect(client.health()).rejects.toMatchObject({
      status: 502,
      code: 'UNEXPECTED_RESPONSE',
      problem: undefined,
    });
  });

  it('reports a response that breaks the contract as a ContractError', async () => {
    const { client } = setup(() => json(200, { status: 'surprise' }));
    await expect(client.health()).rejects.toBeInstanceOf(ContractError);
  });

  it('reports a dropped connection as a NetworkError', async () => {
    const { client } = setup(() => {
      throw new TypeError('fetch failed');
    });
    await expect(client.health()).rejects.toMatchObject({ name: 'NetworkError', timedOut: false });
  });

  it('reports a request that outlives the timeout as a NetworkError with timedOut set', async () => {
    const client = createApiClient({
      baseUrl: 'https://api.example.test/v1',
      platform: 'web',
      timeoutMs: 5,
      // Like the real fetch: never answers, rejects when its signal aborts.
      fetch: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal === undefined || signal === null) return;
          signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    });
    const error = await client.health().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NetworkError);
    expect(error).toMatchObject({ timedOut: true });
  });
});

describe('@akiba/api-client: web session', () => {
  it('logs in, keeps the access token in memory, and sends it on authenticated calls', async () => {
    const { client, calls, events } = setup((request) =>
      request.url.endsWith('/auth/login')
        ? json(200, { ...tokens('access-1'), user: USER })
        : json(200, USER),
    );
    await expect(
      client.auth.login({ email: USER.email, password: 'correct horse battery' }),
    ).resolves.toEqual(IDENTITY);
    expect(client.isSignedIn()).toBe(true);
    expect(events).toEqual(['signed-in']);

    await client.me();
    expect(calls[1]?.headers['authorization']).toBe('Bearer access-1');
    // Web never puts a refresh token in a body or a header; it travels as a cookie.
    expect(JSON.stringify(calls)).not.toContain('refreshToken');
  });

  it('renews an access token that is about to expire before using it', async () => {
    const { client, calls, advance } = setup((request) => {
      if (request.url.endsWith('/auth/login'))
        return json(200, { ...tokens('access-1'), user: USER });
      if (request.url.endsWith('/auth/refresh')) return json(200, tokens('access-2'));
      return json(200, USER);
    });
    await client.auth.login({ email: USER.email, password: 'correct horse battery' });
    advance(890_000); // 15 minutes minus 10 s: inside the 30 s safety margin
    await client.me();
    expect(calls.map((call) => call.url.replace('https://api.example.test/v1', ''))).toEqual([
      '/auth/login',
      '/auth/refresh',
      '/me',
    ]);
    expect(calls[2]?.headers['authorization']).toBe('Bearer access-2');
  });

  it('merges concurrent renewals into ONE refresh request (a second use would be theft)', async () => {
    let refreshes = 0;
    const { client, advance } = setup(async (request) => {
      if (request.url.endsWith('/auth/login'))
        return json(200, { ...tokens('access-1'), user: USER });
      if (request.url.endsWith('/auth/refresh')) {
        refreshes += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return json(200, tokens('access-2'));
      }
      return json(200, USER);
    });
    await client.auth.login({ email: USER.email, password: 'correct horse battery' });
    advance(900_000);
    await Promise.all([
      client.me(),
      client.me(),
      client.me(),
      client.auth.resendVerification().catch(() => undefined),
    ]);
    expect(refreshes).toBe(1);
  });

  it('renews once and retries once when the server refuses the token with 401', async () => {
    let meCalls = 0;
    const { client, calls } = setup((request) => {
      if (request.url.endsWith('/auth/login'))
        return json(200, { ...tokens('access-1'), user: USER });
      if (request.url.endsWith('/auth/refresh')) return json(200, tokens('access-2'));
      meCalls += 1;
      return meCalls === 1 ? problem(401, 'UNAUTHENTICATED') : json(200, USER);
    });
    await client.auth.login({ email: USER.email, password: 'correct horse battery' });
    await expect(client.me()).resolves.toEqual(USER);
    expect(calls.map((call) => call.headers['authorization'])).toEqual([
      undefined,
      'Bearer access-1',
      undefined,
      'Bearer access-2',
    ]);
  });

  it('does not retry forever: a second 401 is returned to the caller', async () => {
    const { client, calls } = setup((request) => {
      if (request.url.endsWith('/auth/login'))
        return json(200, { ...tokens('access-1'), user: USER });
      if (request.url.endsWith('/auth/refresh')) return json(200, tokens('access-2'));
      return problem(401, 'UNAUTHENTICATED');
    });
    await client.auth.login({ email: USER.email, password: 'correct horse battery' });
    await expect(client.me()).rejects.toMatchObject({ status: 401 });
    expect(calls.filter((call) => call.url.endsWith('/me'))).toHaveLength(2);
  });

  it('ends the session when the server says the refresh token is dead', async () => {
    const { client, events } = setup((request) => {
      if (request.url.endsWith('/auth/login'))
        return json(200, { ...tokens('access-1', undefined, 1), user: USER });
      return problem(401, 'INVALID_REFRESH_TOKEN');
    });
    await client.auth.login({ email: USER.email, password: 'correct horse battery' });
    await expect(client.me()).rejects.toMatchObject({ code: 'INVALID_REFRESH_TOKEN' });
    expect(client.isSignedIn()).toBe(false);
    expect(events).toEqual(['signed-in', 'signed-out']);
  });

  it('keeps the session when renewal fails for a reason that says nothing about it', async () => {
    const { client, events, advance } = setup((request) => {
      if (request.url.endsWith('/auth/login'))
        return json(200, { ...tokens('access-1'), user: USER });
      return problem(503, 'NOT_READY');
    });
    await client.auth.login({ email: USER.email, password: 'correct horse battery' });
    advance(900_000);
    await expect(client.me()).rejects.toMatchObject({ status: 503 });
    expect(client.isSignedIn()).toBe(true);
    expect(events).toEqual(['signed-in']);
  });

  it('clears the local session on logout even when the server cannot be reached', async () => {
    const { client, events } = setup((request) => {
      if (request.url.endsWith('/auth/login'))
        return json(200, { ...tokens('access-1'), user: USER });
      throw new TypeError('offline');
    });
    await client.auth.login({ email: USER.email, password: 'correct horse battery' });
    await expect(client.auth.logout()).rejects.toBeInstanceOf(NetworkError);
    expect(client.isSignedIn()).toBe(false);
    expect(events).toEqual(['signed-in', 'signed-out']);
  });

  it('ends the local session after logout-all and after a password reset', async () => {
    const { client } = setup((request) => {
      if (request.url.endsWith('/auth/login'))
        return json(200, { ...tokens('access-1'), user: USER });
      if (request.url.endsWith('/auth/password/reset'))
        return json(200, { status: 'password_reset' });
      return new Response(null, { status: 204 });
    });
    await client.auth.login({ email: USER.email, password: 'correct horse battery' });
    await client.auth.logoutAll();
    expect(client.isSignedIn()).toBe(false);

    await client.auth.login({ email: USER.email, password: 'correct horse battery' });
    await client.auth.resetPassword({ token: 't', newPassword: 'another long passphrase' });
    expect(client.isSignedIn()).toBe(false);
  });

  it('keeps the session after a password change (other sessions end, this one continues)', async () => {
    const { client } = setup((request) =>
      request.url.endsWith('/auth/login')
        ? json(200, { ...tokens('access-1'), user: USER })
        : new Response(null, { status: 204 }),
    );
    await client.auth.login({ email: USER.email, password: 'correct horse battery' });
    await client.auth.changePassword({
      currentPassword: 'correct horse battery',
      newPassword: 'another long passphrase',
    });
    expect(client.isSignedIn()).toBe(true);
  });

  it('restoreSession returns the user when the cookie is alive and undefined when it is not', async () => {
    const alive = setup((request) =>
      request.url.endsWith('/auth/refresh') ? json(200, tokens('access-1')) : json(200, USER),
    );
    await expect(alive.client.restoreSession()).resolves.toEqual(USER);

    const dead = setup(() => problem(401, 'INVALID_REFRESH_TOKEN'));
    await expect(dead.client.restoreSession()).resolves.toBeUndefined();

    const down = setup(() => problem(503, 'NOT_READY'));
    await expect(down.client.restoreSession()).rejects.toMatchObject({ status: 503 });
  });

  it('stops listening after unsubscribe, and a failing listener does not break a request', async () => {
    const { client } = setup(() => json(200, { ...tokens('access-1'), user: USER }));
    const seen: AuthEvent[] = [];
    const off = client.onAuthChange((event) => seen.push(event));
    client.onAuthChange(() => {
      throw new Error('subscriber bug');
    });
    off();
    await expect(
      client.auth.login({ email: USER.email, password: 'correct horse battery' }),
    ).resolves.toEqual(IDENTITY);
    expect(seen).toEqual([]);
  });
});

describe('@akiba/api-client: mobile session', () => {
  const mobile = (handler: Handler, storage = memoryStorage()) => ({
    storage,
    ...setup(handler, { platform: 'mobile', refreshTokenStorage: storage }),
  });

  it('stores the refresh token from the login body and sends it in the refresh body', async () => {
    const { client, calls, storage, advance } = mobile((request) => {
      if (request.url.endsWith('/auth/login')) {
        return json(200, { ...tokens('access-1', REFRESH_A), user: USER });
      }
      if (request.url.endsWith('/auth/refresh')) return json(200, tokens('access-2', REFRESH_B));
      return json(200, USER);
    });
    await client.auth.login({ email: USER.email, password: 'correct horse battery' });
    expect(storage.value).toBe(REFRESH_A);

    advance(900_000);
    await client.me();
    const refresh = calls.find((call) => call.url.endsWith('/auth/refresh'));
    expect(refresh?.body).toEqual({ refreshToken: REFRESH_A });
    expect(refresh?.headers['x-client']).toBe('mobile');
    // Rotation: the new token replaces the old one before anything else happens.
    expect(storage.value).toBe(REFRESH_B);
  });

  it('treats a refresh response without a refresh token as a contract failure', async () => {
    const { client, advance } = mobile((request) =>
      request.url.endsWith('/auth/login')
        ? json(200, { ...tokens('access-1', REFRESH_A), user: USER })
        : json(200, tokens('access-2')),
    );
    await client.auth.login({ email: USER.email, password: 'correct horse battery' });
    advance(900_000);
    await expect(client.me()).rejects.toBeInstanceOf(ContractError);
  });

  it('restores from the stored token, and reports no session when there is none', async () => {
    const stored = mobile(
      (request) =>
        request.url.endsWith('/auth/refresh')
          ? json(200, tokens('access-1', REFRESH_C))
          : json(200, USER),
      memoryStorage(REFRESH_B),
    );
    await expect(stored.client.restoreSession()).resolves.toEqual(USER);
    expect(stored.storage.value).toBe(REFRESH_C);
    expect(stored.calls[0]?.body).toEqual({ refreshToken: REFRESH_B });

    const empty = mobile(() => json(200, USER));
    await expect(empty.client.restoreSession()).resolves.toBeUndefined();
    expect(empty.calls).toHaveLength(0);
    await expect(empty.client.me()).rejects.toBeInstanceOf(NotSignedInError);
  });

  it('wipes the stored token when the server ends the session', async () => {
    const { client, storage } = mobile(
      () => problem(401, 'INVALID_REFRESH_TOKEN'),
      memoryStorage(REFRESH_A),
    );
    await expect(client.restoreSession()).resolves.toBeUndefined();
    expect(storage.value).toBeUndefined();
  });

  it('sends the stored token on logout and wipes it afterwards', async () => {
    const { client, calls, storage } = mobile(
      () => new Response(null, { status: 204 }),
      memoryStorage(REFRESH_A),
    );
    await client.auth.logout();
    expect(calls[0]?.body).toEqual({ refreshToken: REFRESH_A });
    expect(storage.value).toBeUndefined();
  });
});

describe('@akiba/api-client: two tabs sharing one refresh cookie (doc 09 S-AUTH-5)', () => {
  /**
   * A server that, like the real one, treats a refresh token presented after it was replaced as
   * theft, and a browser whose cookie is updated only when a response arrives. Two clients stand
   * for two tabs: they share the cookie and (when asked) a lock.
   */
  function twoTabs(withLock: boolean) {
    let cookie = 'token-0';
    let serverCurrent = 'token-0';
    let generation = 0;
    let revoked = false;
    const fetchImpl: typeof fetch = async (input) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (!url.endsWith('/auth/refresh')) return json(200, USER);
      const presented = cookie; // the browser attaches the cookie when the request is sent
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (revoked || presented !== serverCurrent) {
        revoked = true; // reuse: the whole session ends
        return problem(401, 'INVALID_REFRESH_TOKEN');
      }
      generation += 1;
      serverCurrent = `token-${generation}`;
      cookie = serverCurrent; // Set-Cookie takes effect when the response is received
      return json(200, tokens(`access-${generation}`));
    };

    let queue: Promise<unknown> = Promise.resolve();
    const lock = <T>(operation: () => Promise<T>): Promise<T> => {
      const run = queue.then(operation, operation);
      queue = run.catch(() => undefined);
      return run;
    };
    const make = () =>
      createApiClient({
        baseUrl: 'https://api.example.test/v1',
        platform: 'web',
        fetch: fetchImpl,
        ...(withLock ? { refreshLock: lock } : {}),
      });
    return { a: make(), b: make() };
  }

  it('without a lock the second tab presents a retired token and the session is lost', async () => {
    const { a, b } = twoTabs(false);
    const results = await Promise.allSettled([a.restoreSession(), b.restoreSession()]);
    expect(
      results.map((result) => result.status === 'fulfilled' && result.value !== undefined),
    ).toEqual([true, false]);
  });

  it('with the lock both tabs renew, one after the other, and the session survives', async () => {
    const { a, b } = twoTabs(true);
    const results = await Promise.all([a.restoreSession(), b.restoreSession()]);
    expect(results.every((user) => user !== undefined)).toBe(true);
    expect(a.isSignedIn() && b.isSignedIn()).toBe(true);
  });
});

describe('@akiba/api-client: titles (T12 endpoints)', () => {
  const card = {
    id: '3f2b8c1e-5a47-4d0e-9d57-0c5d9a3b7e11',
    kind: 'tv',
    titleRomaji: 'Shingeki no Kyojin',
    titleEnglish: 'Attack on Titan',
    titleNative: null,
    coverUrl: null,
    format: 'TV',
    status: 'finished',
    episodesTotal: 25,
    season: 'spring',
    seasonYear: 2013,
    averageScore: 85,
    libraryStatus: null,
    libraryEntryId: null,
  };
  const list = { data: [card], nextCursor: 'abc', meta: { stale: false, source: 'anilist' } };
  const signedIn = (handler: Handler) =>
    setup((request, index) => {
      if (request.url.endsWith('/auth/refresh')) return json(200, tokens('access-1'));
      return handler(request, index);
    });

  it('sends the access token and only the parameters that are set', async () => {
    const { client, calls } = signedIn(() => json(200, list));
    await client.titles.search({ q: 'attack on titan', format: 'tv', limit: 3, cursor: undefined });
    const search = calls.find((call) => call.url.includes('/titles/search'));
    expect(search?.headers['authorization']).toBe('Bearer access-1');
    const url = new URL(search?.url ?? '');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: 'attack on titan',
      format: 'tv',
      limit: '3',
    });
  });

  it('parses a list, a season and a title page with the shared schemas', async () => {
    const { client } = signedIn((request) => {
      if (request.url.includes('/seasons/'))
        return json(200, { ...list, season: 'fall', seasonYear: 2024 });
      if (request.url.endsWith('/relations'))
        return json(200, { data: [{ relationType: 'sequel', titles: [card] }], meta: list.meta });
      if (request.url.includes('/titles/3f2b')) {
        return json(200, {
          data: {
            ...card,
            synopsis: 'x',
            bannerUrl: null,
            durationMin: 24,
            startDate: '2013-04-07',
            endDate: null,
            popularity: 1,
            synonyms: [],
            genres: ['Action'],
            studios: [],
            nextAiring: null,
            franchiseId: null,
          },
          meta: list.meta,
        });
      }
      if (request.url.endsWith('/genres')) return json(200, { data: ['Action', 'Comedy'] });
      return json(200, list);
    });
    await expect(client.titles.browse({ genre: 'Action' })).resolves.toMatchObject({
      nextCursor: 'abc',
    });
    await expect(client.titles.season(2024, 'fall')).resolves.toMatchObject({
      season: 'fall',
      seasonYear: 2024,
    });
    await expect(client.titles.currentSeason()).resolves.toMatchObject({ season: 'fall' });
    await expect(client.titles.detail(card.id)).resolves.toMatchObject({
      data: { genres: ['Action'] },
    });
    await expect(client.titles.relations(card.id)).resolves.toMatchObject({
      data: [{ relationType: 'sequel' }],
    });
    await expect(client.titles.genres()).resolves.toEqual(['Action', 'Comedy']);
  });

  it('parses franchise, studio, studio works, character and cast pages with the shared schemas (T21/T22)', async () => {
    const actor = {
      id: '3f2b8c1e-5a47-4d0e-9d57-0c5d9a3b7e33',
      name: 'Yuki Kaji',
      nativeName: null,
      imageUrl: null,
      language: 'Japanese',
    };
    const { client, calls } = signedIn((request) => {
      if (request.url.includes('/franchises/'))
        return json(200, {
          data: {
            id: card.id,
            name: 'Shingeki no Kyojin',
            titles: [{ ...card, startDate: '2013-04-07' }],
            relations: [{ fromTitleId: card.id, toTitleId: card.id, relationType: 'sequel' }],
            totals: { titles: 1, inLibrary: 0, completed: 0 },
          },
          meta: { stale: false, source: 'cache' },
        });
      if (new URL(request.url).pathname.endsWith('/titles')) return json(200, list);
      if (request.url.includes('/studios/'))
        return json(200, {
          data: { id: card.id, name: 'Wit Studio', isAnimationStudio: true, titleCount: 4 },
          meta: { stale: false, source: 'cache' },
        });
      if (request.url.includes('/characters/'))
        return json(200, {
          data: {
            id: card.id,
            name: 'Eren',
            nativeName: null,
            imageUrl: null,
            description: null,
            voiceActors: [actor],
            appearances: [{ role: 'main', title: card }],
          },
          meta: { stale: false, source: 'cache' },
        });
      return json(200, {
        data: [
          {
            id: card.id,
            name: 'Eren',
            nativeName: null,
            imageUrl: null,
            role: 'main',
            voiceActors: [actor],
          },
        ],
        meta: list.meta,
      });
    });
    await expect(client.explore.franchise(card.id)).resolves.toMatchObject({
      data: { name: 'Shingeki no Kyojin', totals: { titles: 1 } },
    });
    await expect(client.explore.studio(card.id)).resolves.toMatchObject({
      data: { titleCount: 4 },
    });
    await expect(
      client.explore.studioTitles(card.id, { limit: 2, cursor: 'next' }),
    ).resolves.toMatchObject({ nextCursor: 'abc' });
    const works = calls.find((call) => call.url.endsWith('/titles?limit=2&cursor=next'));
    expect(works).toBeDefined();
    await expect(client.explore.character(card.id)).resolves.toMatchObject({
      data: { voiceActors: [{ language: 'Japanese' }], appearances: [{ role: 'main' }] },
    });
    await expect(client.titles.characters(card.id)).resolves.toMatchObject({
      data: [{ name: 'Eren', role: 'main' }],
    });
    await client.explore.franchise('a/b');
    expect(calls.at(-1)?.url).toContain('/franchises/a%2Fb');
  });

  it('escapes a title ID in the path', async () => {
    const { client, calls } = signedIn(() => problem(404, 'NOT_FOUND'));
    await client.titles.detail('a/b?c').catch(() => undefined);
    expect(calls.at(-1)?.url).toContain('/titles/a%2Fb%3Fc');
  });

  it('surfaces a 503 as an ApiError and a changed shape as a ContractError', async () => {
    const down = signedIn(() => problem(503, 'SOURCES_UNAVAILABLE'));
    await expect(down.client.titles.search({ q: 'x' })).rejects.toMatchObject({
      status: 503,
      code: 'SOURCES_UNAVAILABLE',
    });
    const changed = signedIn(() => json(200, { data: [{ id: 'not-a-uuid' }] }));
    await expect(changed.client.titles.browse()).rejects.toBeInstanceOf(ContractError);
  });
});
