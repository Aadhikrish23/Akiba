import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildAuthTestApp,
  getMe,
  loginMobile,
  MINUTE,
  MOBILE_HEADERS,
  newCredentials,
  refreshCookieValue,
  refreshMobile,
  refreshWeb,
  register,
  SECOND,
  setCookieLines,
  WEB_HEADERS,
  type AuthTestApp,
  type Credentials,
} from '../../testing/auth.js';
import { createTestDatabase, type TestDatabase } from '../../testing/database.js';
import {
  APPLE_BUNDLE_ID,
  APPLE_SERVICES_ID,
  FakeCodeExchanger,
  FakeOidcVerifier,
  GOOGLE_MOBILE_CLIENT,
  GOOGLE_WEB_CLIENT,
  newNonce,
  newPkce,
  OAUTH_REDIRECT_URI,
  oauthTestEnv,
  sha256Hex,
  TEST_GOOGLE_CLIENT_SECRET,
  type FakeTokenClaims,
} from '../../testing/oauth.js';
import type { EmailMessage } from '../email/index.js';
import { hashOAuthState } from './oauth/stateStore.js';

const PROBLEM_JSON = /^application\/problem\+json/;
type Provider = 'google' | 'apple';

interface SessionBody {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  refreshToken?: string;
  user: { id: string; email: string; displayName: string | null; emailVerified: boolean };
}

interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail: string;
  errors?: { path: string; message: string }[];
}

/** A problem document without its per-request ID. */
function problem(response: request.Response): Problem {
  expect(response.headers['content-type']).toMatch(PROBLEM_JSON);
  const { requestId, ...rest } = response.body as Problem & { requestId: string };
  expect(requestId).toEqual(expect.any(String));
  return rest;
}

const SIGN_IN_FAILED: Problem = {
  type: '/errors/oauth-sign-in-failed',
  title: 'Sign-in failed',
  status: 401,
  code: 'OAUTH_SIGN_IN_FAILED',
  detail: 'Sign-in with the provider could not be completed. Start again.',
};

const INVALID_STATE: Problem = {
  type: '/errors/invalid-oauth-state',
  title: 'Sign-in attempt expired',
  status: 400,
  code: 'INVALID_OAUTH_STATE',
  detail: 'This sign-in attempt is invalid, has expired or was already used. Start again.',
};

function tokenIn(message: EmailMessage): string {
  const match = /#token=([^\s"<]+)/.exec(message.text);
  if (match?.[1] === undefined) throw new Error(`the ${message.kind} email has no token link`);
  return match[1];
}

describe('OAuth sign-in, link and unlink (T6)', () => {
  let testDb: TestDatabase;
  let t: AuthTestApp;
  let idp: FakeOidcVerifier;
  let tokenEndpoint: FakeCodeExchanger;
  let subjectCounter = 0;

  beforeAll(async () => {
    testDb = await createTestDatabase();
  });
  afterAll(async () => {
    await testDb.drop();
  });
  beforeEach(async () => {
    await testDb.reset();
    idp = new FakeOidcVerifier();
    tokenEndpoint = new FakeCodeExchanger();
    t = await buildAuthTestApp({
      db: testDb.db.client,
      env: oauthTestEnv(),
      oidcVerifier: idp,
      oauthCodeExchanger: tokenEndpoint,
    });
  });

  // ── helpers ──

  const db = () => testDb.db.client;
  const newSubject = (): string => `provider-subject-${(subjectCounter += 1)}`;

  /** What a native app sends: an ID token from the provider SDK plus the nonce it used. */
  function mobileSignIn(
    provider: Provider,
    claims: Omit<FakeTokenClaims, 'provider' | 'nonce'> & { nonce?: string },
    sentNonce?: string,
  ): request.Test {
    const nonce = claims.nonce ?? newNonce();
    const idToken = idp.issue({ ...claims, provider, nonce });
    return request(t.app)
      .post(`/v1/auth/oauth/${provider}`)
      .set(MOBILE_HEADERS)
      .send({ idToken, nonce: sentNonce ?? nonce });
  }

  async function signedIn(
    provider: Provider,
    claims: Omit<FakeTokenClaims, 'provider' | 'nonce'>,
  ): Promise<SessionBody & { refreshToken: string }> {
    const response = await mobileSignIn(provider, claims);
    if (response.status !== 200) {
      throw new Error(`oauth sign-in failed: ${response.status} ${JSON.stringify(response.body)}`);
    }
    return response.body as SessionBody & { refreshToken: string };
  }

  const start = (provider: Provider, challenge: string, redirectUri = OAUTH_REDIRECT_URI) =>
    request(t.app)
      .post(`/v1/auth/oauth/${provider}/start`)
      .set(WEB_HEADERS)
      .send({ redirectUri, codeChallenge: challenge });

  interface StartedFlow {
    readonly state: string;
    readonly nonce: string;
    readonly verifier: string;
    readonly challenge: string;
    readonly url: URL;
  }

  /** The browser's half of the web flow up to the redirect to the provider. */
  async function startedFlow(provider: Provider): Promise<StartedFlow> {
    const pkce = newPkce();
    const response = await start(provider, pkce.challenge);
    if (response.status !== 200) {
      throw new Error(`start failed: ${response.status} ${JSON.stringify(response.body)}`);
    }
    const body = response.body as { authorizationUrl: string; state: string };
    const url = new URL(body.authorizationUrl);
    return {
      state: body.state,
      nonce: url.searchParams.get('nonce') ?? '',
      verifier: pkce.verifier,
      challenge: pkce.challenge,
      url,
    };
  }

  /** The provider's half: the user signs in there and comes back with a code. */
  function providerCode(
    provider: Provider,
    flow: StartedFlow,
    claims: Omit<FakeTokenClaims, 'provider' | 'nonce'> & { nonce?: string },
  ): string {
    const idToken = idp.issue({ nonce: flow.nonce, ...claims, provider });
    return tokenEndpoint.issueCode({ provider, idToken, codeChallenge: flow.challenge });
  }

  const complete = (provider: Provider, body: object): request.Test =>
    request(t.app).post(`/v1/auth/oauth/${provider}`).set(WEB_HEADERS).send(body);

  async function verifiedPasswordAccount(label = 'verified'): Promise<Credentials> {
    const credentials = newCredentials(label);
    await register(t.app, credentials);
    await t.settle();
    const token = tokenIn(t.emails.last(credentials.email, 'verify_email'));
    const verified = await request(t.app).post('/v1/auth/verify-email').send({ token });
    expect(verified.status).toBe(200);
    t.emails.clear();
    return credentials;
  }

  async function unverifiedPasswordAccount(label = 'unverified'): Promise<Credentials> {
    const credentials = newCredentials(label);
    await register(t.app, credentials);
    await t.settle();
    t.emails.clear();
    return credentials;
  }

  const userByEmail = (email: string) =>
    db().user.findUnique({ where: { email }, include: { oauthAccounts: true } });

  const link = (accessToken: string, body: object): request.Test =>
    request(t.app)
      .post('/v1/auth/oauth/link')
      .set(MOBILE_HEADERS)
      .set('Authorization', `Bearer ${accessToken}`)
      .send(body);

  function linkBody(
    provider: Provider,
    claims: Omit<FakeTokenClaims, 'provider' | 'nonce'>,
    extra: object = {},
  ): object {
    const nonce = newNonce();
    return { provider, idToken: idp.issue({ ...claims, provider, nonce }), nonce, ...extra };
  }

  const unlink = (accessToken: string, provider: string): request.Test =>
    request(t.app)
      .delete(`/v1/auth/oauth/${provider}`)
      .set(MOBILE_HEADERS)
      .set('Authorization', `Bearer ${accessToken}`);

  const methods = (accessToken: string): request.Test =>
    request(t.app).get('/v1/auth/oauth').set('Authorization', `Bearer ${accessToken}`);

  // ───────────────────────── sign-in: new and returning users ─────────────────────────

  describe('sign-in with an ID token (mobile)', () => {
    it('FR-AUTH-002: a new user signs in with Google and gets a verified account without a password', async () => {
      const subject = newSubject();
      const response = await mobileSignIn('google', {
        subject,
        email: 'ada@example.test',
        name: 'Ada Lovelace',
        audience: GOOGLE_MOBILE_CLIENT,
      });

      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const body = response.body as SessionBody;
      expect(body).toEqual({
        accessToken: expect.any(String) as string,
        tokenType: 'Bearer',
        expiresIn: 900,
        refreshToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as string,
        user: {
          id: expect.any(String) as string,
          email: 'ada@example.test',
          displayName: 'Ada Lovelace',
          emailVerified: true,
        },
      });
      // Mobile transport: the refresh token is in the body and no cookie is set.
      expect(setCookieLines(response)).toEqual([]);

      const user = await userByEmail('ada@example.test');
      expect(user).toMatchObject({
        id: body.user.id,
        passwordHash: null,
        emailVerifiedAt: t.clock.now(),
      });
      expect(user?.oauthAccounts).toEqual([
        expect.objectContaining({ provider: 'google', providerUserId: subject }),
      ]);

      // The session is a normal one: the access token works and the refresh token rotates.
      const me = await getMe(t.app, body.accessToken);
      expect(me.status).toBe(200);
      expect(me.body).toEqual(body.user);
      const refreshed = await refreshMobile(t.app, body.refreshToken as string);
      expect(refreshed.status).toBe(200);

      // The verifier was asked to check the audience against every configured Google client.
      expect(idp.calls.at(-1)?.expected).toMatchObject({
        audiences: [GOOGLE_WEB_CLIENT, GOOGLE_MOBILE_CLIENT],
        allowHashedNonce: true,
      });
    });

    it('FR-AUTH-002: the same Google identity signs in to the same account again', async () => {
      const subject = newSubject();
      const first = await signedIn('google', { subject, email: 'ada@example.test' });
      const second = await signedIn('google', { subject, email: 'ada@example.test' });
      expect(second.user.id).toBe(first.user.id);
      expect(await db().user.count()).toBe(1);
      expect(await db().oAuthAccount.count()).toBe(1);
    });

    it('FR-AUTH-002: a new user signs in with Apple using a private-relay address', async () => {
      const subject = newSubject();
      const response = await mobileSignIn('apple', {
        subject,
        email: 'x7k2q@privaterelay.appleid.com',
        isPrivateEmail: true,
        audience: APPLE_BUNDLE_ID,
      });
      expect(response.status).toBe(200);
      expect((response.body as SessionBody).user).toMatchObject({
        email: 'x7k2q@privaterelay.appleid.com',
        displayName: null,
        emailVerified: true,
      });
      expect(idp.calls.at(-1)?.expected.audiences).toEqual([APPLE_SERVICES_ID, APPLE_BUNDLE_ID]);
    });

    it('FR-AUTH-002: Apple native sign-in may put the SHA-256 of the nonce in the token', async () => {
      const raw = newNonce();
      const response = await mobileSignIn(
        'apple',
        { subject: newSubject(), email: 'hashed@example.test', nonce: sha256Hex(raw) },
        raw,
      );
      expect(response.status).toBe(200);
    });

    it('FR-AUTH-002: Apple sends no email on later logins; the account is found by its sub', async () => {
      const subject = newSubject();
      const first = await signedIn('apple', { subject, email: 'relay1@privaterelay.appleid.com' });

      const later = await mobileSignIn('apple', { subject, email: null });
      expect(later.status).toBe(200);
      expect((later.body as SessionBody).user).toEqual(first.user);
      expect(await db().user.count()).toBe(1);
    });

    it('FR-AUTH-002: a first Apple sign-in without an email creates nothing', async () => {
      const response = await mobileSignIn('apple', { subject: newSubject(), email: null });
      expect(response.status).toBe(403);
      expect(problem(response)).toMatchObject({ code: 'OAUTH_EMAIL_NOT_VERIFIED' });
      expect(await db().user.count()).toBe(0);
      expect(await db().oAuthAccount.count()).toBe(0);
      expect(await db().refreshToken.count()).toBe(0);
    });

    it('FR-AUTH-002: two simultaneous first sign-ins with one identity make one account', async () => {
      const subject = newSubject();
      const responses = await Promise.all(
        [1, 2, 3, 4].map(() =>
          mobileSignIn('google', { subject, email: 'race@example.test' }).then((r) => r),
        ),
      );
      expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
      const ids = new Set(responses.map((response) => (response.body as SessionBody).user.id));
      expect(ids.size).toBe(1);
      expect(await db().user.count()).toBe(1);
      expect(await db().oAuthAccount.count()).toBe(1);
    });
  });

  // ───────────────────────── account rules ─────────────────────────

  describe('account rules (S-AUTH-9, Q-04)', () => {
    it('FR-AUTH-002 / S-AUTH-9: a verified provider email links to an existing VERIFIED account', async () => {
      const credentials = await verifiedPasswordAccount();
      const before = await userByEmail(credentials.email);
      const subject = newSubject();

      // citext: the provider's spelling of the address does not matter.
      const response = await mobileSignIn('google', {
        subject,
        email: credentials.email.toUpperCase(),
        name: 'Name At Google',
      });
      expect(response.status).toBe(200);
      const body = response.body as SessionBody;
      expect(body.user.id).toBe(before?.id);
      // The account keeps its own profile; nothing is taken over from the provider.
      expect(body.user.displayName).toBe('Test User');
      expect(body.user.email).toBe(credentials.email);

      const after = await userByEmail(credentials.email);
      expect(after?.oauthAccounts).toEqual([
        expect.objectContaining({ provider: 'google', providerUserId: subject }),
      ]);
      expect(after?.passwordHash).toBe(before?.passwordHash);
      expect(await db().user.count()).toBe(1);

      // The password still works, and the owner is told that a sign-in method was added.
      await loginMobile(t.app, credentials);
      await t.settle();
      const notice = t.emails.last(credentials.email, 'sign_in_method_changed');
      expect(notice.subject).toBe('Google sign-in was added to your Akiba account');
      expect(notice.text).not.toContain('#token=');
    });

    it('S-AUTH-9 / Q-04: an UNVERIFIED password account is neither linked nor signed in to', async () => {
      // Someone (possibly not the owner of the address) registered it and never verified.
      const squatter = await unverifiedPasswordAccount();
      const before = await userByEmail(squatter.email);
      const sessionsBefore = await db().refreshToken.count();

      const response = await mobileSignIn('google', {
        subject: newSubject(),
        email: squatter.email,
      });

      expect(response.status).toBe(409);
      expect(problem(response)).toEqual({
        type: '/errors/account-email-unverified',
        title: 'Account email not confirmed',
        status: 409,
        code: 'ACCOUNT_EMAIL_UNVERIFIED',
        detail:
          'An account with this email address exists, but the address was never confirmed. Reset its password to take control of it, then sign in with the provider again.',
      });
      expect(response.body).not.toHaveProperty('accessToken');
      expect(setCookieLines(response)).toEqual([]);

      // Nothing changed: no identity, no session, same password, still unverified, no email.
      const after = await userByEmail(squatter.email);
      expect(after).toEqual(before);
      expect(after?.oauthAccounts).toEqual([]);
      expect(after?.emailVerifiedAt).toBeNull();
      expect(await db().oAuthAccount.count()).toBe(0);
      expect(await db().refreshToken.count()).toBe(sessionsBefore);
      expect(await db().user.count()).toBe(1);
      await t.settle();
      expect(t.emails.sent).toEqual([]);
    });

    it('S-AUTH-9 / Q-04: after the owner resets the password, the squatter is out and the provider links', async () => {
      const squatter = await unverifiedPasswordAccount();
      const squatterSession = await loginMobile(t.app, squatter);
      const subject = newSubject();
      const refused = await mobileSignIn('google', { subject, email: squatter.email });
      expect(refused.status).toBe(409);

      // The real owner of the mailbox follows the advice in the problem detail.
      await request(t.app).post('/v1/auth/password/forgot').send({ email: squatter.email });
      await t.settle();
      const token = tokenIn(t.emails.last(squatter.email, 'reset_password'));
      const reset = await request(t.app)
        .post('/v1/auth/password/reset')
        .send({ token, newPassword: 'the real owner chose this 1' });
      expect(reset.status).toBe(200);

      // The squatter's session and password are gone...
      expect((await getMe(t.app, squatterSession.accessToken)).status).toBe(401);
      const oldPassword = await request(t.app).post('/v1/auth/login').send(squatter);
      expect(oldPassword.status).toBe(401);
      // ...and now the provider sign-in links to the (verified) account.
      const linked = await mobileSignIn('google', { subject, email: squatter.email });
      expect(linked.status).toBe(200);
      expect((linked.body as SessionBody).user.id).toBe(squatterSession.userId);
    });

    it('S-AUTH-9: an unverified provider email never creates an account', async () => {
      const response = await mobileSignIn('google', {
        subject: newSubject(),
        email: 'unverified-at-google@example.test',
        emailVerified: false,
      });
      expect(response.status).toBe(403);
      expect(problem(response)).toEqual({
        type: '/errors/oauth-email-not-verified',
        title: 'Email address not confirmed by the provider',
        status: 403,
        code: 'OAUTH_EMAIL_NOT_VERIFIED',
        detail:
          'The sign-in provider did not confirm an email address for this account. Confirm it with the provider and try again.',
      });
      expect(await db().user.count()).toBe(0);
      expect(await db().oAuthAccount.count()).toBe(0);
    });

    it('S-AUTH-9: an unverified provider email never links to an existing account, verified or not', async () => {
      const verified = await verifiedPasswordAccount();
      const unverified = await unverifiedPasswordAccount();
      for (const email of [verified.email, unverified.email]) {
        const response = await mobileSignIn('google', {
          subject: newSubject(),
          email,
          emailVerified: false,
        });
        expect(response.status).toBe(403);
        expect(problem(response).code).toBe('OAUTH_EMAIL_NOT_VERIFIED');
      }
      expect(await db().oAuthAccount.count()).toBe(0);
      await t.settle();
      expect(t.emails.sent).toEqual([]);
    });

    it('S-AUTH-9: never auto-merges on email mismatch: a linked identity stays with its account', async () => {
      const subject = newSubject();
      const alice = await signedIn('google', { subject, email: 'alice@example.test' });
      const bob = await verifiedPasswordAccount('bob');

      // Alice's Google account now carries Bob's address (changed at the provider).
      const response = await mobileSignIn('google', { subject, email: bob.email });
      expect(response.status).toBe(200);
      const body = response.body as SessionBody;
      expect(body.user.id).toBe(alice.user.id);
      expect(body.user.email).toBe('alice@example.test');
      expect((await userByEmail(bob.email))?.oauthAccounts).toEqual([]);
      expect(await db().oAuthAccount.count()).toBe(1);
    });

    it('S-AUTH-9: a second identity of the same provider is not added to an account by email', async () => {
      const first = await signedIn('google', { subject: newSubject(), email: 'one@example.test' });
      // A different Google account that (now) has the same address.
      const response = await mobileSignIn('google', {
        subject: newSubject(),
        email: 'one@example.test',
      });
      expect(response.status).toBe(409);
      expect(problem(response).code).toBe('OAUTH_PROVIDER_ALREADY_LINKED');
      expect(await db().oAuthAccount.count({ where: { userId: first.user.id } })).toBe(1);
    });

    it('FR-AUTH-002: an account in deletion cannot be signed in to, by identity or by email', async () => {
      const subject = newSubject();
      const user = await signedIn('google', { subject, email: 'leaving@example.test' });
      await db().user.update({ where: { id: user.user.id }, data: { deletedAt: t.clock.now() } });

      const byIdentity = await mobileSignIn('google', { subject, email: 'leaving@example.test' });
      expect(byIdentity.status).toBe(401);
      expect(problem(byIdentity)).toEqual(SIGN_IN_FAILED);

      const byEmail = await mobileSignIn('apple', {
        subject: newSubject(),
        email: 'leaving@example.test',
      });
      expect(byEmail.status).toBe(401);
      expect(problem(byEmail)).toEqual(SIGN_IN_FAILED);
      expect(await db().oAuthAccount.count()).toBe(1);
    });
  });

  // ───────────────────────── refused tokens ─────────────────────────

  describe('refused ID tokens', () => {
    it('S-AUTH-9: wrong nonce, wrong aud, another provider and unknown tokens get one identical 401', async () => {
      const nonce = newNonce();
      const attempts: request.Test[] = [
        // The app sends a nonce that is not the one in the token.
        mobileSignIn('google', { subject: 's1', email: 'a@example.test' }, newNonce()),
        // A token issued to some other application.
        mobileSignIn('google', {
          subject: 's2',
          email: 'a@example.test',
          audience: 'other-app.apps.googleusercontent.test',
        }),
        // A Google token presented to the Apple endpoint.
        request(t.app)
          .post('/v1/auth/oauth/apple')
          .set(MOBILE_HEADERS)
          .send({
            idToken: idp.issue({
              provider: 'google',
              subject: 's3',
              email: 'a@example.test',
              nonce,
            }),
            nonce,
          }),
        // Not a token the provider ever issued.
        request(t.app)
          .post('/v1/auth/oauth/google')
          .set(MOBILE_HEADERS)
          .send({ idToken: 'eyJhbGciOiJub25lIn0.e30.', nonce }),
      ];
      for (const attempt of attempts) {
        const response = await attempt;
        expect(response.status).toBe(401);
        expect(problem(response)).toEqual(SIGN_IN_FAILED);
        expect(setCookieLines(response)).toEqual([]);
      }
      expect(await db().user.count()).toBe(0);
      expect(await db().refreshToken.count()).toBe(0);
    });

    it('S-AUTH-9: when the provider keys cannot be fetched the answer is 503 and nothing is created', async () => {
      idp.unavailable = true;
      const response = await mobileSignIn('google', { subject: 's1', email: 'a@example.test' });
      expect(response.status).toBe(503);
      expect(response.headers['retry-after']).toBe('30');
      expect(problem(response)).toMatchObject({ code: 'OAUTH_PROVIDER_UNAVAILABLE' });
      expect(await db().user.count()).toBe(0);
    });
  });

  // ───────────────────────── web flow: state, nonce, PKCE ─────────────────────────

  describe('web flow: authorization code + PKCE', () => {
    it('S-AUTH-9: start returns a Google authorization URL with state, nonce and the S256 challenge', async () => {
      const pkce = newPkce();
      const response = await start('google', pkce.challenge);
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const body = response.body as { authorizationUrl: string; state: string; expiresIn: number };
      expect(body.expiresIn).toBe(600);
      expect(body.state).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const url = new URL(body.authorizationUrl);
      expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
      const params = Object.fromEntries(url.searchParams);
      expect(params).toEqual({
        response_type: 'code',
        client_id: GOOGLE_WEB_CLIENT,
        redirect_uri: OAUTH_REDIRECT_URI,
        scope: 'openid email profile',
        state: body.state,
        nonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as string,
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256',
      });
      expect(params['nonce']).not.toBe(body.state);

      // Only the hash of the state is stored.
      const rows = await db().oAuthState.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        stateHash: hashOAuthState(body.state),
        provider: 'google',
        nonce: params['nonce'],
        codeChallenge: pkce.challenge,
        redirectUri: OAUTH_REDIRECT_URI,
        usedAt: null,
        expiresAt: new Date(t.clock.now().getTime() + 10 * MINUTE),
      });
      expect(JSON.stringify(rows)).not.toContain(body.state);
    });

    it('S-AUTH-9: the Apple authorization URL asks for form_post and uses the Services ID', async () => {
      const flow = await startedFlow('apple');
      expect(`${flow.url.origin}${flow.url.pathname}`).toBe(
        'https://appleid.apple.com/auth/authorize',
      );
      expect(Object.fromEntries(flow.url.searchParams)).toMatchObject({
        response_type: 'code',
        response_mode: 'form_post',
        client_id: APPLE_SERVICES_ID,
        scope: 'name email',
        code_challenge_method: 'S256',
        state: flow.state,
      });
    });

    it('S-AUTH-9: every start gets its own state and nonce', async () => {
      const flows = await Promise.all([startedFlow('google'), startedFlow('google')]);
      expect(flows[0]?.state).not.toBe(flows[1]?.state);
      expect(flows[0]?.nonce).not.toBe(flows[1]?.nonce);
    });

    it('S-AUTH-9: start refuses a redirect URI that is not registered', async () => {
      const response = await start('google', newPkce().challenge, 'https://evil.test/callback');
      expect(response.status).toBe(422);
      expect(problem(response).errors).toEqual([
        { path: 'redirectUri', message: 'is not a redirect URI registered for this server' },
      ]);
      expect(await db().oAuthState.count()).toBe(0);
    });

    it('FR-AUTH-002 / S-AUTH-9: a new user completes the Google web flow; the refresh token arrives as a cookie', async () => {
      const flow = await startedFlow('google');
      const code = providerCode('google', flow, {
        subject: newSubject(),
        email: 'web@example.test',
      });

      const response = await complete('google', {
        code,
        codeVerifier: flow.verifier,
        redirectUri: OAUTH_REDIRECT_URI,
        state: flow.state,
      });

      expect(response.status).toBe(200);
      const body = response.body as SessionBody;
      expect(body.user).toMatchObject({ email: 'web@example.test', emailVerified: true });
      // Web transport: HttpOnly cookie, never the body.
      expect(body).not.toHaveProperty('refreshToken');
      const cookie = setCookieLines(response).find((line) => line.startsWith('akiba_refresh='));
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/Secure/);
      expect(cookie).toMatch(/SameSite=Lax/);
      expect(cookie).toMatch(/Path=\/v1\/auth/);
      const refreshed = await refreshWeb(t.app, refreshCookieValue(response) as string);
      expect(refreshed.status).toBe(200);

      // The provider was sent exactly what the browser presented...
      expect(tokenEndpoint.calls).toEqual([
        {
          provider: 'google',
          request: { code, codeVerifier: flow.verifier, redirectUri: OAUTH_REDIRECT_URI },
        },
      ]);
      // ...and the ID token was checked against the web client and the STORED nonce, exactly.
      expect(idp.calls.at(-1)?.expected).toEqual({
        audiences: [GOOGLE_WEB_CLIENT],
        nonce: flow.nonce,
        allowHashedNonce: false,
      });
      expect((await db().oAuthState.findFirst())?.usedAt).toEqual(t.clock.now());
    });

    it('FR-AUTH-002 / S-AUTH-9: the Apple web flow works the same way', async () => {
      const flow = await startedFlow('apple');
      const code = providerCode('apple', flow, {
        subject: newSubject(),
        email: 'apple-web@privaterelay.appleid.com',
      });
      const response = await complete('apple', {
        code,
        codeVerifier: flow.verifier,
        redirectUri: OAUTH_REDIRECT_URI,
        state: flow.state,
      });
      expect(response.status).toBe(200);
      expect(idp.calls.at(-1)?.expected.audiences).toEqual([APPLE_SERVICES_ID]);
    });

    /** A flow that would succeed, for tests that then break exactly one thing. */
    async function readyFlow(): Promise<{ flow: StartedFlow; body: Record<string, string> }> {
      const flow = await startedFlow('google');
      const code = providerCode('google', flow, { subject: newSubject(), email: 'w@example.test' });
      return {
        flow,
        body: {
          code,
          codeVerifier: flow.verifier,
          redirectUri: OAUTH_REDIRECT_URI,
          state: flow.state,
        },
      };
    }

    async function expectInvalidState(response: request.Response): Promise<void> {
      expect(response.status).toBe(400);
      expect(problem(response)).toEqual(INVALID_STATE);
      expect(setCookieLines(response)).toEqual([]);
      // Refused before anything was sent to the provider, and nothing was created.
      expect(tokenEndpoint.calls).toEqual([]);
      expect(await db().user.count()).toBe(0);
      expect(await db().refreshToken.count()).toBe(0);
    }

    it('S-AUTH-9: a missing state is refused', async () => {
      const { body } = await readyFlow();
      const { state: _state, ...withoutState } = body;
      const response = await complete('google', withoutState);
      expect(response.status).toBe(422);
      expect(problem(response).code).toBe('VALIDATION_ERROR');
      expect(tokenEndpoint.calls).toEqual([]);
    });

    it('S-AUTH-9: an unknown or malformed state is refused', async () => {
      const { body } = await readyFlow();
      for (const state of [newNonce(), 'not-a-state', `${body['state'] as string}x`]) {
        await expectInvalidState(await complete('google', { ...body, state }));
      }
    });

    it('S-AUTH-9: state is single-use: a replayed state is refused', async () => {
      const { flow, body } = await readyFlow();
      const first = await complete('google', body);
      expect(first.status).toBe(200);

      // Same state again, even with a fresh, valid code for the same PKCE pair.
      const secondCode = providerCode('google', flow, {
        subject: 'another',
        email: 'x@example.test',
      });
      const replay = await complete('google', { ...body, code: secondCode });
      expect(replay.status).toBe(400);
      expect(problem(replay)).toEqual(INVALID_STATE);
      expect(tokenEndpoint.calls).toHaveLength(1);
      expect(await db().user.count()).toBe(1);
    });

    it('S-AUTH-9: of several simultaneous completions with one state, exactly one succeeds', async () => {
      const { body } = await readyFlow();
      const responses = await Promise.all([1, 2, 3, 4].map(() => complete('google', body)));
      const statuses = responses.map((response) => response.status).sort();
      expect(statuses).toEqual([200, 400, 400, 400]);
      expect(tokenEndpoint.calls).toHaveLength(1);
    });

    it('S-AUTH-9: an expired state is refused (10 minutes)', async () => {
      const { body } = await readyFlow();
      t.clock.advance(10 * MINUTE);
      await expectInvalidState(await complete('google', body));
    });

    it('S-AUTH-9: a state is still good just before it expires', async () => {
      const { body } = await readyFlow();
      t.clock.advance(10 * MINUTE - SECOND);
      expect((await complete('google', body)).status).toBe(200);
    });

    it('S-AUTH-9: a state started for one provider cannot finish at the other', async () => {
      const { body } = await readyFlow();
      await expectInvalidState(await complete('apple', body));
    });

    it('S-AUTH-9: the redirect URI must be the one the flow started with', async () => {
      const { body } = await readyFlow();
      await expectInvalidState(
        await complete('google', { ...body, redirectUri: `${OAUTH_REDIRECT_URI}?x=1` }),
      );
    });

    it('S-AUTH-9: PKCE: without the verifier of the browser that started, a state cannot be used (login CSRF)', async () => {
      // An attacker has the state and a code (their own), but the victim's browser has no
      // verifier for it; any other verifier is refused, and the attempt uses the state up.
      const { body } = await readyFlow();
      await expectInvalidState(
        await complete('google', { ...body, codeVerifier: newPkce().verifier }),
      );
      await expectInvalidState(await complete('google', body));
    });

    it('S-AUTH-9: an ID token whose nonce is not the one made at start is refused', async () => {
      const flow = await startedFlow('google');
      for (const nonce of [newNonce(), sha256Hex(flow.nonce)]) {
        const again = nonce === sha256Hex(flow.nonce) ? await startedFlow('google') : flow;
        const code = providerCode('google', again, {
          subject: newSubject(),
          email: 'n@example.test',
          nonce: nonce === sha256Hex(flow.nonce) ? sha256Hex(again.nonce) : nonce,
        });
        const response = await complete('google', {
          code,
          codeVerifier: again.verifier,
          redirectUri: OAUTH_REDIRECT_URI,
          state: again.state,
        });
        expect(response.status).toBe(401);
        expect(problem(response)).toEqual(SIGN_IN_FAILED);
      }
      expect(await db().user.count()).toBe(0);
    });

    it('S-AUTH-9: the web flow accepts only an ID token issued to the web client (aud)', async () => {
      const flow = await startedFlow('google');
      const code = providerCode('google', flow, {
        subject: newSubject(),
        email: 'aud@example.test',
        audience: GOOGLE_MOBILE_CLIENT, // valid for the mobile path, not here
      });
      const response = await complete('google', {
        code,
        codeVerifier: flow.verifier,
        redirectUri: OAUTH_REDIRECT_URI,
        state: flow.state,
      });
      expect(response.status).toBe(401);
      expect(problem(response)).toEqual(SIGN_IN_FAILED);
      expect(await db().user.count()).toBe(0);
    });

    it('S-AUTH-9: a code the provider refuses is a 401; an unreachable provider is a 503', async () => {
      const refused = await readyFlow();
      const response = await complete('google', { ...refused.body, code: 'never-issued' });
      expect(response.status).toBe(401);
      expect(problem(response)).toEqual(SIGN_IN_FAILED);

      const down = await readyFlow();
      tokenEndpoint.unavailable = true;
      const unavailable = await complete('google', down.body);
      expect(unavailable.status).toBe(503);
      expect(problem(unavailable).code).toBe('OAUTH_PROVIDER_UNAVAILABLE');
      expect(await db().user.count()).toBe(0);
    });

    it('S-AUTH-9: starting a flow removes expired records', async () => {
      await startedFlow('google');
      await startedFlow('apple');
      expect(await db().oAuthState.count()).toBe(2);
      t.clock.advance(10 * MINUTE);
      await startedFlow('google');
      expect(await db().oAuthState.count()).toBe(1);
    });
  });

  // ───────────────────────── Apple callback relay ─────────────────────────

  describe('Apple form_post relay', () => {
    const relay = (form: Record<string, string>): request.Test =>
      request(t.app)
        .post('/v1/auth/oauth/apple/callback')
        .set('Origin', 'https://appleid.apple.com')
        .type('form')
        .send(form);

    it('S-AUTH-9: passes code and state on to the web app with a 303 and does nothing else', async () => {
      const response = await relay({
        code: 'c0de.from-apple_1',
        state: 'S'.repeat(43),
        user: '{"name":{"firstName":"Ada"},"email":"ada@example.test"}',
        id_token: 'header.payload.signature',
      });
      expect(response.status).toBe(303);
      const target = new URL(response.headers['location'] as string);
      expect(`${target.origin}${target.pathname}`).toBe('http://localhost:5173/oauth/callback');
      expect(Object.fromEntries(target.searchParams)).toEqual({
        provider: 'apple',
        code: 'c0de.from-apple_1',
        state: 'S'.repeat(43),
      });
      expect(setCookieLines(response)).toEqual([]);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(await db().user.count()).toBe(0);
      expect(await db().refreshToken.count()).toBe(0);
    });

    it('S-AUTH-9: passes a provider error on, and anything unusable becomes invalid_response', async () => {
      const denied = await relay({ error: 'user_cancelled_authorize', state: 'S'.repeat(43) });
      expect(denied.status).toBe(303);
      expect(
        Object.fromEntries(new URL(denied.headers['location'] as string).searchParams),
      ).toEqual({ provider: 'apple', state: 'S'.repeat(43), error: 'user_cancelled_authorize' });

      const unusable: Record<string, string>[] = [
        {},
        { state: 'S'.repeat(43) },
        { code: 'has space', state: 'ok' },
        { code: 'c', error: '<script>alert(1)</script>' },
        { code: 'c', error: 'access_denied' },
      ];
      for (const form of unusable) {
        const response = await relay(form);
        expect(response.status).toBe(303);
        const target = new URL(response.headers['location'] as string);
        expect(`${target.origin}${target.pathname}`).toBe('http://localhost:5173/oauth/callback');
        expect(target.searchParams.get('code')).toBeNull();
        expect(target.searchParams.get('error')).toBe(
          form['error'] === 'access_denied' ? 'access_denied' : 'invalid_response',
        );
      }

      // A state that is not shaped like one is dropped, never copied into the URL.
      const oddState = await relay({ code: 'c', state: 'https://evil.test/?a=b&c=d' });
      const target = new URL(oddState.headers['location'] as string);
      expect(Object.fromEntries(target.searchParams)).toEqual({ provider: 'apple', code: 'c' });
    });
  });

  // ───────────────────────── link ─────────────────────────

  describe('link a provider', () => {
    it('FR-AUTH-007: a password account links Google with its current password and can then sign in with it', async () => {
      const credentials = await verifiedPasswordAccount();
      const session = await loginMobile(t.app, credentials);
      const subject = newSubject();

      const response = await link(
        session.accessToken,
        // The provider account has a different address: explicit linking does not need a match.
        linkBody(
          'google',
          { subject, email: 'other-address@example.test' },
          {
            currentPassword: credentials.password,
          },
        ),
      );
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ hasPassword: true, providers: ['google'] });

      const viaGoogle = await signedIn('google', { subject, email: 'other-address@example.test' });
      expect(viaGoogle.user.id).toBe(session.userId);
      expect(viaGoogle.user.email).toBe(credentials.email);
      expect(await db().user.count()).toBe(1);

      await t.settle();
      expect(t.emails.last(credentials.email, 'sign_in_method_changed').subject).toBe(
        'Google sign-in was added to your Akiba account',
      );
    });

    it('FR-AUTH-007: linking works through the web flow too', async () => {
      const credentials = await verifiedPasswordAccount();
      const session = await loginMobile(t.app, credentials);
      const flow = await startedFlow('apple');
      const code = providerCode('apple', flow, { subject: newSubject(), email: null });
      const response = await link(session.accessToken, {
        provider: 'apple',
        code,
        codeVerifier: flow.verifier,
        redirectUri: OAUTH_REDIRECT_URI,
        state: flow.state,
        currentPassword: credentials.password,
      });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ hasPassword: true, providers: ['apple'] });
    });

    it('FR-AUTH-007 / S-AUTH-11: a password account must confirm its current password to link', async () => {
      const credentials = await verifiedPasswordAccount();
      const session = await loginMobile(t.app, credentials);

      const missing = await link(session.accessToken, linkBody('google', { subject: 's' }));
      expect(missing.status).toBe(422);
      expect(problem(missing).errors).toEqual([
        { path: 'currentPassword', message: 'is required for an account with a password' },
      ]);

      const wrong = await link(
        session.accessToken,
        linkBody('google', { subject: 's' }, { currentPassword: 'not the password' }),
      );
      expect(wrong.status).toBe(403);
      expect(problem(wrong).code).toBe('REAUTHENTICATION_FAILED');
      expect(await db().oAuthAccount.count()).toBe(0);
      // The provider token was never even looked at.
      expect(idp.calls).toEqual([]);
    });

    it('S-AUTH-4: guessing the current password on link is throttled like login', async () => {
      const credentials = await verifiedPasswordAccount();
      const session = await loginMobile(t.app, credentials);
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 7; attempt += 1) {
        const response = await link(
          session.accessToken,
          linkBody('google', { subject: 's' }, { currentPassword: `guess ${attempt}` }),
        );
        statuses.push(response.status);
      }
      expect(statuses.slice(0, 5)).toEqual([403, 403, 403, 403, 403]);
      expect(statuses).toContain(429);
    });

    it('S-AUTH-9 / Q-04: an account with an UNVERIFIED email cannot link a provider', async () => {
      // Otherwise whoever pre-registered someone's address could attach their own Google
      // account and keep access after the real owner resets the password.
      const squatter = await unverifiedPasswordAccount();
      const session = await loginMobile(t.app, squatter);
      const response = await link(
        session.accessToken,
        linkBody(
          'google',
          { subject: newSubject(), email: 'attacker@example.test' },
          {
            currentPassword: squatter.password,
          },
        ),
      );
      expect(response.status).toBe(403);
      expect(problem(response).code).toBe('EMAIL_NOT_VERIFIED');
      expect(await db().oAuthAccount.count()).toBe(0);
    });

    it('FR-AUTH-007 / S-AUTH-11: an account without a password links only shortly after signing in', async () => {
      const fresh = await signedIn('google', { subject: newSubject(), email: 'o@example.test' });
      const linked = await link(fresh.accessToken, linkBody('apple', { subject: newSubject() }));
      expect(linked.status).toBe(200);
      expect(linked.body).toEqual({ hasPassword: false, providers: ['google', 'apple'] });

      await unlink(fresh.accessToken, 'apple');
      t.clock.advance(10 * MINUTE + SECOND);
      const stale = await link(fresh.accessToken, linkBody('apple', { subject: newSubject() }));
      expect(stale.status).toBe(403);
      expect(problem(stale)).toMatchObject({
        code: 'REAUTHENTICATION_REQUIRED',
        detail: 'Sign in again, then repeat this change within a few minutes.',
      });
      expect(await db().oAuthAccount.count()).toBe(1);
    });

    it('FR-AUTH-007: a provider identity that belongs to another user cannot be linked', async () => {
      const subject = newSubject();
      const owner = await signedIn('google', { subject, email: 'owner@example.test' });
      const credentials = await verifiedPasswordAccount('second');
      const session = await loginMobile(t.app, credentials);

      const response = await link(
        session.accessToken,
        linkBody(
          'google',
          { subject, email: 'owner@example.test' },
          {
            currentPassword: credentials.password,
          },
        ),
      );
      expect(response.status).toBe(409);
      expect(problem(response)).toMatchObject({
        code: 'OAUTH_IDENTITY_IN_USE',
        detail: 'This provider account is already linked to a different user.',
      });
      const rows = await db().oAuthAccount.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.userId).toBe(owner.user.id);
    });

    it('FR-AUTH-007: linking the same identity again changes nothing; a second identity of the provider is refused', async () => {
      const subject = newSubject();
      const user = await signedIn('google', { subject, email: 'same@example.test' });

      const again = await link(user.accessToken, linkBody('google', { subject }));
      expect(again.status).toBe(200);
      expect(again.body).toEqual({ hasPassword: false, providers: ['google'] });

      const other = await link(user.accessToken, linkBody('google', { subject: newSubject() }));
      expect(other.status).toBe(409);
      expect(problem(other).code).toBe('OAUTH_PROVIDER_ALREADY_LINKED');
      expect(await db().oAuthAccount.count()).toBe(1);
    });

    it('FR-AUTH-007: link needs a valid access token and a valid provider token', async () => {
      const anonymous = await request(t.app)
        .post('/v1/auth/oauth/link')
        .send(linkBody('google', { subject: 's' }));
      expect(anonymous.status).toBe(401);
      expect(problem(anonymous).code).toBe('UNAUTHENTICATED');

      const user = await signedIn('google', { subject: newSubject(), email: 'l@example.test' });
      const badToken = await link(user.accessToken, {
        provider: 'apple',
        idToken: 'not-issued-by-apple',
        nonce: newNonce(),
      });
      expect(badToken.status).toBe(401);
      expect(problem(badToken)).toEqual(SIGN_IN_FAILED);
      expect(await db().oAuthAccount.count()).toBe(1);
    });
  });

  // ───────────────────────── unlink ─────────────────────────

  describe('unlink a provider', () => {
    it('FR-AUTH-007: an account with a password can unlink its provider', async () => {
      const credentials = await verifiedPasswordAccount();
      const subject = newSubject();
      const session = await signedIn('google', { subject, email: credentials.email });
      t.emails.clear();

      const response = await unlink(session.accessToken, 'google');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ hasPassword: true, providers: [] });
      expect(await db().oAuthAccount.count()).toBe(0);

      // The session that did it stays; the password still works.
      expect((await getMe(t.app, session.accessToken)).status).toBe(200);
      await loginMobile(t.app, credentials);
      await t.settle();
      expect(t.emails.last(credentials.email, 'sign_in_method_changed').subject).toBe(
        'Google sign-in was removed from your Akiba account',
      );
    });

    it('FR-AUTH-007: the last sign-in method cannot be unlinked (no password, one provider)', async () => {
      const user = await signedIn('google', { subject: newSubject(), email: 'only@example.test' });
      const response = await unlink(user.accessToken, 'google');
      expect(response.status).toBe(409);
      expect(problem(response)).toEqual({
        type: '/errors/last-sign-in-method',
        title: 'Last sign-in method',
        status: 409,
        code: 'LAST_SIGN_IN_METHOD',
        detail:
          'This is the only way to sign in to the account. Set a password or link another provider first.',
      });
      expect(await db().oAuthAccount.count()).toBe(1);
      await t.settle();
      expect(t.emails.sent).toEqual([]);
    });

    it('FR-AUTH-007: with two providers one can go, and then the other is the last one', async () => {
      const user = await signedIn('google', { subject: newSubject(), email: 'two@example.test' });
      await link(user.accessToken, linkBody('apple', { subject: newSubject() }));

      const first = await unlink(user.accessToken, 'google');
      expect(first.status).toBe(200);
      expect(first.body).toEqual({ hasPassword: false, providers: ['apple'] });
      const second = await unlink(user.accessToken, 'apple');
      expect(second.status).toBe(409);
      expect(problem(second).code).toBe('LAST_SIGN_IN_METHOD');
      expect(await db().oAuthAccount.count()).toBe(1);
    });

    it('FR-AUTH-007: two simultaneous unlinks cannot leave an account without a sign-in method', async () => {
      for (let round = 0; round < 5; round += 1) {
        const user = await signedIn('google', {
          subject: newSubject(),
          email: `race-${round}@example.test`,
        });
        await link(user.accessToken, linkBody('apple', { subject: newSubject() }));

        const responses = await Promise.all([
          unlink(user.accessToken, 'google').then((r) => r),
          unlink(user.accessToken, 'apple').then((r) => r),
        ]);
        expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
        expect(await db().oAuthAccount.count({ where: { userId: user.user.id } })).toBe(1);
      }
    });

    it('FR-AUTH-007: an OAuth-only user who sets a password by reset can then unlink the provider', async () => {
      const user = await signedIn('google', { subject: newSubject(), email: 'pw@example.test' });
      expect((await unlink(user.accessToken, 'google')).status).toBe(409);

      await request(t.app).post('/v1/auth/password/forgot').send({ email: 'pw@example.test' });
      await t.settle();
      const token = tokenIn(t.emails.last('pw@example.test', 'reset_password'));
      const reset = await request(t.app)
        .post('/v1/auth/password/reset')
        .send({ token, newPassword: 'a password of my own 42' });
      expect(reset.status).toBe(200);

      const session = await loginMobile(t.app, {
        email: 'pw@example.test',
        password: 'a password of my own 42',
      });
      const response = await unlink(session.accessToken, 'google');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ hasPassword: true, providers: [] });
    });

    it('FR-AUTH-007: unlinking a provider that is not linked is 404; an unknown provider is 422', async () => {
      const user = await signedIn('google', { subject: newSubject(), email: 'u@example.test' });
      const notLinked = await unlink(user.accessToken, 'apple');
      expect(notLinked.status).toBe(404);
      expect(problem(notLinked).code).toBe('NOT_FOUND');

      const unknown = await unlink(user.accessToken, 'github');
      expect(unknown.status).toBe(422);
      expect(problem(unknown).errors).toEqual([
        { path: 'params.provider', message: 'must be one of: google, apple' },
      ]);
    });

    it('FR-AUTH-007: unlink needs a valid access token', async () => {
      const response = await request(t.app).delete('/v1/auth/oauth/google');
      expect(response.status).toBe(401);
      expect(problem(response).code).toBe('UNAUTHENTICATED');
    });

    it('SEC-004: unlink and the methods list act on the caller only', async () => {
      const credentials = await verifiedPasswordAccount('alice');
      const alice = await signedIn('google', { subject: newSubject(), email: credentials.email });
      const bob = await signedIn('apple', { subject: newSubject(), email: 'bob@example.test' });

      // Bob has no Google link; Alice's must not be touched by his request.
      expect((await unlink(bob.accessToken, 'google')).status).toBe(404);
      expect(await db().oAuthAccount.count({ where: { userId: alice.user.id } })).toBe(1);

      expect((await methods(alice.accessToken)).body).toEqual({
        hasPassword: true,
        providers: ['google'],
      });
      expect((await methods(bob.accessToken)).body).toEqual({
        hasPassword: false,
        providers: ['apple'],
      });
      expect((await request(t.app).get('/v1/auth/oauth')).status).toBe(401);
    });
  });

  // ───────────────────────── transport, CSRF, validation, limits ─────────────────────────

  describe('transport, validation and limits', () => {
    it('S-AUTH-7: a browser origin that is not allowed is refused before anything else', async () => {
      const nonce = newNonce();
      const idToken = idp.issue({
        provider: 'google',
        subject: 's',
        email: 'c@example.test',
        nonce,
      });
      const response = await request(t.app)
        .post('/v1/auth/oauth/google')
        .set('Origin', 'https://evil.test')
        .send({ idToken, nonce });
      expect(response.status).toBe(403);
      expect(problem(response).code).toBe('CSRF_REJECTED');
      expect(idp.calls).toEqual([]);

      const startResponse = await request(t.app)
        .post('/v1/auth/oauth/google/start')
        .set('Origin', 'https://evil.test')
        .send({ redirectUri: OAUTH_REDIRECT_URI, codeChallenge: newPkce().challenge });
      expect(startResponse.status).toBe(403);
    });

    it('doc 09 §4: malformed bodies and unknown providers are 422 and reach neither verifier nor database', async () => {
      const nonce = newNonce();
      const pkce = newPkce();
      const codeBody = {
        code: 'c',
        codeVerifier: pkce.verifier,
        redirectUri: OAUTH_REDIRECT_URI,
        state: 's',
      };
      const bodies: object[] = [
        {},
        { idToken: 'a.b.c' },
        { idToken: 'a.b.c', nonce: 'short' },
        { idToken: 'a.b.c', nonce, userId: 'someone-else' },
        { idToken: 'a.b.c', nonce, ...codeBody },
        { ...codeBody, codeVerifier: 'too-short' },
        { ...codeBody, redirectUri: 'not a url' },
        { ...codeBody, email: 'chosen-by-the-client@example.test' },
      ];
      for (const body of bodies) {
        const response = await request(t.app).post('/v1/auth/oauth/google').send(body);
        expect(response.status, JSON.stringify(body)).toBe(422);
        expect(problem(response).code).toBe('VALIDATION_ERROR');
      }
      const unknownProvider = await request(t.app)
        .post('/v1/auth/oauth/github')
        .send({ idToken: 'a.b.c', nonce });
      expect(unknownProvider.status).toBe(422);
      const unknownStart = await request(t.app)
        .post('/v1/auth/oauth/github/start')
        .send({ redirectUri: OAUTH_REDIRECT_URI, codeChallenge: pkce.challenge });
      expect(unknownStart.status).toBe(422);
      const badLink = await request(t.app).post('/v1/auth/oauth/link').send({ provider: 'google' });
      expect(badLink.status).toBe(401); // authentication comes before validation

      expect(idp.calls).toEqual([]);
      expect(await db().oAuthState.count()).toBe(0);
    });

    it('doc 07 §1: the OAuth routes share the per-IP auth limit', async () => {
      const limited = await buildAuthTestApp({
        db: testDb.db.client,
        env: { ...oauthTestEnv(), API_RATE_LIMIT_AUTH_MAX: '3' },
        oidcVerifier: idp,
        oauthCodeExchanger: tokenEndpoint,
      });
      const statuses: number[] = [];
      for (let index = 0; index < 5; index += 1) {
        const response = await request(limited.app)
          .post('/v1/auth/oauth/google')
          .send({ idToken: 'x', nonce: newNonce() });
        statuses.push(response.status);
      }
      expect(statuses).toEqual([401, 401, 401, 429, 429]);
    });
  });

  // ───────────────────────── providers switched off ─────────────────────────

  describe('providers that are not configured', () => {
    const NOT_CONFIGURED = {
      type: '/errors/oauth-provider-not-configured',
      title: 'Sign-in provider not available',
      status: 501,
      code: 'OAUTH_PROVIDER_NOT_CONFIGURED',
    };

    it('FR-AUTH-002: without client IDs every provider route answers 501 and the rest of auth works', async () => {
      const bare = await buildAuthTestApp({
        db: testDb.db.client,
        oidcVerifier: idp,
        oauthCodeExchanger: tokenEndpoint,
      });
      const nonce = newNonce();
      for (const provider of ['google', 'apple'] as const) {
        const signIn = await request(bare.app)
          .post(`/v1/auth/oauth/${provider}`)
          .send({
            idToken: idp.issue({ provider, subject: 's', email: 'a@example.test', nonce }),
            nonce,
          });
        expect(signIn.status).toBe(501);
        expect(problem(signIn)).toEqual({
          ...NOT_CONFIGURED,
          detail: 'Sign-in with this provider is not set up on this server.',
        });
        const started = await request(bare.app)
          .post(`/v1/auth/oauth/${provider}/start`)
          .send({
            redirectUri: 'http://localhost:5173/oauth/callback',
            codeChallenge: newPkce().challenge,
          });
        expect(started.status).toBe(501);
      }
      expect(idp.calls).toEqual([]);

      const credentials = newCredentials();
      await register(bare.app, credentials);
      const session = await loginMobile(bare.app, credentials);
      expect((await getMe(bare.app, session.accessToken)).status).toBe(200);
      const linkAttempt = await request(bare.app)
        .get('/v1/auth/oauth')
        .set('Authorization', `Bearer ${session.accessToken}`);
      expect(linkAttempt.body).toEqual({ hasPassword: true, providers: [] });
    });

    it('FR-AUTH-002: with client IDs but no client secret the ID-token path works and the web flow answers 501', async () => {
      const mobileOnly = await buildAuthTestApp({
        db: testDb.db.client,
        env: { GOOGLE_CLIENT_IDS: GOOGLE_WEB_CLIENT },
        oidcVerifier: idp,
        oauthCodeExchanger: tokenEndpoint,
      });
      const nonce = newNonce();
      const viaToken = await request(mobileOnly.app)
        .post('/v1/auth/oauth/google')
        .set(MOBILE_HEADERS)
        .send({
          idToken: idp.issue({ provider: 'google', subject: 'm', email: 'm@example.test', nonce }),
          nonce,
        });
      expect(viaToken.status).toBe(200);

      const pkce = newPkce();
      const started = await request(mobileOnly.app)
        .post('/v1/auth/oauth/google/start')
        .send({
          redirectUri: 'http://localhost:5173/oauth/callback',
          codeChallenge: pkce.challenge,
        });
      expect(started.status).toBe(501);
      expect(problem(started)).toEqual({
        ...NOT_CONFIGURED,
        detail: 'Browser sign-in with this provider is not set up on this server.',
      });
      const viaCode = await request(mobileOnly.app).post('/v1/auth/oauth/google').send({
        code: 'c',
        codeVerifier: pkce.verifier,
        redirectUri: 'http://localhost:5173/oauth/callback',
        state: newNonce(),
      });
      expect(viaCode.status).toBe(501);
      expect(tokenEndpoint.calls).toEqual([]);
    });
  });

  // ───────────────────────── logs ─────────────────────────

  describe('redaction (doc 09 §7)', () => {
    it('S-AUTH-9: ID tokens, codes, verifiers, nonces, states, secrets and addresses never reach the logs', async () => {
      const secrets: string[] = [TEST_GOOGLE_CLIENT_SECRET];
      const email = 'private-person@example.test';
      const subject = newSubject();

      // Web flow, success.
      const flow = await startedFlow('google');
      const code = providerCode('google', flow, { subject, email });
      await complete('google', {
        code,
        codeVerifier: flow.verifier,
        redirectUri: OAUTH_REDIRECT_URI,
        state: flow.state,
      });
      secrets.push(code, flow.verifier, flow.state, flow.nonce, flow.challenge);

      // Mobile, success and failures.
      const nonce = newNonce();
      const idToken = idp.issue({ provider: 'google', subject, email, nonce });
      const ok = await request(t.app)
        .post('/v1/auth/oauth/google')
        .set(MOBILE_HEADERS)
        .send({ idToken, nonce });
      const session = ok.body as SessionBody;
      secrets.push(idToken, nonce, session.accessToken, session.refreshToken as string);

      const badNonce = newNonce();
      const badToken = idp.issue({ provider: 'google', subject: 'x', email, nonce: newNonce() });
      await request(t.app)
        .post('/v1/auth/oauth/google')
        .set(MOBILE_HEADERS)
        .send({ idToken: badToken, nonce: badNonce });
      secrets.push(badToken, badNonce);

      // Refusals that involve an address.
      const squatter = await unverifiedPasswordAccount();
      await mobileSignIn('apple', { subject: newSubject(), email: squatter.email });
      await mobileSignIn('apple', { subject: newSubject(), email, emailVerified: false });

      // A bad state, a link and an unlink.
      const lost = await startedFlow('apple');
      await complete('apple', {
        code: 'some-code-value-1234567890',
        codeVerifier: newPkce().verifier,
        redirectUri: OAUTH_REDIRECT_URI,
        state: lost.state,
      });
      secrets.push(lost.state, lost.nonce, 'some-code-value-1234567890');
      const linkNonce = newNonce();
      const linkToken = idp.issue({ provider: 'apple', subject: newSubject(), nonce: linkNonce });
      await link(session.accessToken, { provider: 'apple', idToken: linkToken, nonce: linkNonce });
      await unlink(session.accessToken, 'apple');
      secrets.push(linkToken, linkNonce);

      // The Apple relay.
      await request(t.app)
        .post('/v1/auth/oauth/apple/callback')
        .type('form')
        .send({ code: 'relay-code-abcdefghij', state: 'relay-state-abcdefghij' });
      secrets.push('relay-code-abcdefghij', 'relay-state-abcdefghij');

      await t.settle();
      const logs = t.logs.text;
      // The flows above did log (so the check below is not vacuous)...
      for (const event of [
        'oauth_start',
        'oauth_sign_in',
        'oauth_token_refused',
        'oauth_state_refused',
        'oauth_unverified_account_refused',
        'oauth_email_unverified',
        'oauth_link',
        'oauth_unlink',
      ]) {
        expect(logs, event).toContain(`"event":"${event}"`);
      }
      // ...and none of the secret or personal values is in there.
      for (const secret of secrets) {
        expect(logs).not.toContain(secret);
      }
      expect(logs).not.toContain(email);
      expect(logs).not.toContain(squatter.email);
      expect(logs).not.toContain(subject);
      expect(logs).not.toContain('fake-id-token.');
      expect(logs).not.toContain('fake-code.');
    });
  });
});
