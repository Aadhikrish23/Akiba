import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  ApiError,
  NotSignedInError,
  createApiClient,
  type ApiClient,
  type RefreshTokenStorage,
} from '@akiba/api-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MINUTE,
  WEB_ORIGIN,
  buildAuthTestApp,
  newCredentials,
  type AuthTestApp,
  type Credentials,
} from '../../testing/auth.js';
import { createTestDatabase, type TestDatabase } from '../../testing/database.js';
import type { EmailKind } from '../email/index.js';

/**
 * T7: the typed client (`@akiba/api-client`) against the real application on a real database,
 * over real HTTP. The client's clock is the test clock the server uses, so "the access token is
 * about to expire" is something the test can cause on both sides at once.
 */

/** What a browser does for the client: send `Origin` and keep the refresh cookie. */
class CookieJar {
  #refreshCookie: string | undefined;

  get refreshCookie(): string | undefined {
    return this.#refreshCookie;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    headers.set('Origin', WEB_ORIGIN);
    if (this.#refreshCookie !== undefined && url.pathname.startsWith('/v1/auth')) {
      headers.set('Cookie', `akiba_refresh=${this.#refreshCookie}`);
    }
    const response = await fetch(input, { ...init, headers });
    for (const line of response.headers.getSetCookie()) {
      const match = /^akiba_refresh=([^;]*)/.exec(line);
      if (match === null) continue;
      const expired = /max-age=0/i.test(line) || /expires=thu, 01 jan 1970/i.test(line);
      this.#refreshCookie = expired || match[1] === '' ? undefined : match[1];
    }
    return response;
  };
}

const memoryStorage = (): RefreshTokenStorage & { value: string | undefined } => {
  const storage = {
    value: undefined as string | undefined,
    get: () => storage.value,
    set: (token: string | undefined) => {
      storage.value = token;
    },
  };
  return storage;
};

function tokenIn(text: string): string {
  const match = /#token=([^\s"<]+)/.exec(text);
  if (match?.[1] === undefined) throw new Error('the email has no token link');
  return match[1];
}

describe('api-client against the real API (T7)', () => {
  let testDb: TestDatabase;
  let t: AuthTestApp;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
  });
  afterAll(async () => {
    await testDb.drop();
  });
  beforeEach(async () => {
    await testDb.reset();
    t = await buildAuthTestApp({ db: testDb.db.client });
    server = createServer(t.app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
  });

  const mobileClient = (storage = memoryStorage()): ApiClient =>
    createApiClient({
      baseUrl,
      platform: 'mobile',
      clientVersion: '1.0.0',
      refreshTokenStorage: storage,
      now: () => t.clock.now().getTime(),
    });

  const webClient = (jar: CookieJar): ApiClient =>
    createApiClient({
      baseUrl,
      platform: 'web',
      clientVersion: '1.0.0',
      fetch: jar.fetch,
      now: () => t.clock.now().getTime(),
    });

  async function registered(client: ApiClient): Promise<Credentials> {
    const credentials = newCredentials('client');
    await client.auth.register({ ...credentials, displayName: 'Client Test' });
    await t.settle();
    return credentials;
  }

  const emailToken = (address: string, kind: EmailKind): string =>
    tokenIn(t.emails.last(address, kind).text);

  it('reports liveness and readiness through the typed probes', async () => {
    const client = mobileClient();
    await expect(client.health()).resolves.toEqual({ status: 'ok' });
    await expect(client.ready()).resolves.toMatchObject({ status: 'ready' });
  });

  it('registers, logs in, and reads /me with the same shapes the server sends (mobile)', async () => {
    const storage = memoryStorage();
    const client = mobileClient(storage);
    const credentials = await registered(client);

    const user = await client.auth.login(credentials);
    expect(user).toMatchObject({ email: credentials.email, emailVerified: false });
    expect(client.isSignedIn()).toBe(true);
    // The mobile transport: the refresh token is in the client's storage, not in the user object.
    expect(storage.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(client.me()).resolves.toEqual(user);
  });

  it('verifies an email through the emailed link and /me then says so', async () => {
    const client = mobileClient();
    const credentials = await registered(client);
    await client.auth.login(credentials);

    await expect(
      client.auth.verifyEmail(emailToken(credentials.email, 'verify_email')),
    ).resolves.toEqual({ status: 'verified' });
    await expect(client.me()).resolves.toMatchObject({ emailVerified: true });
    // A used link is dead, and the failure carries the API's own code.
    await expect(
      client.auth.verifyEmail(emailToken(credentials.email, 'verify_email')),
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_TOKEN' });
  });

  it('surfaces API failures as ApiError with the code, field errors and request id', async () => {
    const client = mobileClient();
    const credentials = await registered(client);

    const wrongPassword = await client.auth
      .login({ email: credentials.email, password: 'definitely not the password' })
      .catch((caught: unknown) => caught);
    expect(wrongPassword).toBeInstanceOf(ApiError);
    expect(wrongPassword).toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS' });
    expect((wrongPassword as ApiError).requestId).toEqual(expect.any(String));

    const invalid = await client.auth
      .register({ email: 'not-an-email', password: 'correct horse battery 99', displayName: 'X' })
      .catch((caught: unknown) => caught);
    expect(invalid).toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
    expect((invalid as ApiError).errors.map((error) => error.path)).toContain('email');

    expect(client.isSignedIn()).toBe(false);
  });

  it('renews an expiring access token on its own and rotates the stored refresh token (mobile)', async () => {
    const storage = memoryStorage();
    const client = mobileClient(storage);
    await client.auth.login(await registered(client));
    const firstRefreshToken = storage.value;

    t.clock.advance(16 * MINUTE); // past the 15-minute access token
    await expect(client.me()).resolves.toMatchObject({ emailVerified: false });
    expect(storage.value).not.toBe(firstRefreshToken);
    expect(storage.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('never presents one refresh token twice, even for concurrent calls (no false reuse alarm)', async () => {
    const client = mobileClient();
    await client.auth.login(await registered(client));

    t.clock.advance(16 * MINUTE);
    const results = await Promise.all([client.me(), client.me(), client.me(), client.me()]);
    expect(results.every((user) => user.emailVerified === false)).toBe(true);

    // Had the client refreshed twice, the server would have revoked the family and this fails.
    t.clock.advance(16 * MINUTE);
    await expect(client.me()).resolves.toBeDefined();
    expect(client.isSignedIn()).toBe(true);
  });

  it('logout ends the session on the server: the old refresh token cannot be used again', async () => {
    const storage = memoryStorage();
    const client = mobileClient(storage);
    await client.auth.login(await registered(client));
    const stolen = storage.value;

    await client.auth.logout();
    expect(client.isSignedIn()).toBe(false);
    await expect(client.me()).rejects.toBeInstanceOf(NotSignedInError);

    // Someone who copied the token earlier gets nothing from it.
    const replayStorage = memoryStorage();
    replayStorage.value = stolen;
    const attacker = mobileClient(replayStorage);
    await expect(attacker.restoreSession()).resolves.toBeUndefined();
    expect(replayStorage.value).toBeUndefined();
  });

  it('restores a web session from the cookie and drops it on logout', async () => {
    const jar = new CookieJar();
    const first = webClient(jar);
    const credentials = await registered(first);
    await first.auth.login(credentials);
    expect(jar.refreshCookie).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // A page reload: a new client object, the same browser cookie.
    const reloaded = webClient(jar);
    expect(reloaded.isSignedIn()).toBe(false);
    await expect(reloaded.restoreSession()).resolves.toMatchObject({ email: credentials.email });
    expect(reloaded.isSignedIn()).toBe(true);

    await reloaded.auth.logout();
    expect(jar.refreshCookie).toBeUndefined();
    await expect(webClient(jar).restoreSession()).resolves.toBeUndefined();
  });

  it('forgot and reset password end every session and let the new password in', async () => {
    const client = mobileClient();
    const credentials = await registered(client);
    await client.auth.login(credentials);

    await expect(client.auth.forgotPassword({ email: credentials.email })).resolves.toEqual({
      status: 'accepted',
    });
    // An unknown address gets the very same answer.
    await expect(client.auth.forgotPassword({ email: 'nobody@example.test' })).resolves.toEqual({
      status: 'accepted',
    });
    await t.settle();

    const newPassword = 'a brand new passphrase 7';
    await expect(
      client.auth.resetPassword({
        token: emailToken(credentials.email, 'reset_password'),
        newPassword,
      }),
    ).resolves.toEqual({ status: 'password_reset' });
    expect(client.isSignedIn()).toBe(false);

    await expect(client.auth.login(credentials)).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    await expect(
      client.auth.login({ email: credentials.email, password: newPassword }),
    ).resolves.toMatchObject({ email: credentials.email });
  });

  it('changes the password for the caller while the caller stays signed in', async () => {
    const client = mobileClient();
    const credentials = await registered(client);
    await client.auth.login(credentials);

    await client.auth.changePassword({
      currentPassword: credentials.password,
      newPassword: 'another long passphrase 3',
    });
    expect(client.isSignedIn()).toBe(true);
    await expect(client.me()).resolves.toBeDefined();

    await expect(
      client.auth.changePassword({
        currentPassword: 'wrong current password',
        newPassword: 'yet another passphrase 4',
      }),
    ).rejects.toMatchObject({ status: 403, code: 'REAUTHENTICATION_FAILED' });
  });

  it('logout-all ends the sessions of every device', async () => {
    const credentials = newCredentials('multi');
    const phoneStorage = memoryStorage();
    const phone = mobileClient(phoneStorage);
    const tablet = mobileClient();
    await phone.auth.register({ ...credentials, displayName: 'Two Devices' });
    await phone.auth.login(credentials);
    await tablet.auth.login(credentials);

    await phone.auth.logoutAll();
    expect(phone.isSignedIn()).toBe(false);

    t.clock.advance(16 * MINUTE);
    await expect(tablet.me()).rejects.toMatchObject({ status: 401 });
    expect(tablet.isSignedIn()).toBe(false);
  });
});
