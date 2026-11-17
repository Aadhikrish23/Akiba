import { createPublicKey } from 'node:crypto';
import { SignJWT } from 'jose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TestClock } from '../../../testing/auth.js';
import {
  APPLE_BUNDLE_ID,
  APPLE_SERVICES_ID,
  b64url,
  generateRsaSigningKey,
  GOOGLE_MOBILE_CLIENT,
  GOOGLE_WEB_CLIENT,
  newNonce,
  sha256Hex,
  TestIdentityProvider,
  type TestSigningKey,
} from '../../../testing/oauth.js';
import {
  JwksOidcVerifier,
  OIDC_CLOCK_SKEW_SECONDS,
  OIDC_MAX_TOKEN_AGE_SECONDS,
  OidcVerificationError,
  type OidcExpectations,
} from './oidcVerifier.js';

/**
 * The REAL verifier, against real RSA signatures. The "providers" are key pairs generated here;
 * their key sets are served by an in-process `fetch` stand-in that refuses any other URL, so
 * these tests cannot reach Google or Apple even by mistake.
 */
describe('JwksOidcVerifier (T6): Google and Apple ID tokens against JWKS', () => {
  let googleKey: TestSigningKey;
  let appleKey: TestSigningKey;
  let strangerKey: TestSigningKey;

  beforeAll(() => {
    googleKey = generateRsaSigningKey('google-key-1');
    appleKey = generateRsaSigningKey('apple-key-1');
    strangerKey = generateRsaSigningKey('google-key-1'); // same kid, different key
  });

  let clock: TestClock;
  let google: TestIdentityProvider;
  let apple: TestIdentityProvider;
  let verifier: JwksOidcVerifier;
  let nonce: string;
  let googleExpected: OidcExpectations;
  let appleExpected: OidcExpectations;

  const build = (refetchCooldownMs?: number): JwksOidcVerifier =>
    new JwksOidcVerifier({
      now: clock.now,
      fetch: (url) => (url.includes('apple') ? apple.fetch(url) : google.fetch(url)),
      ...(refetchCooldownMs === undefined ? {} : { refetchCooldownMs }),
    });

  beforeEach(() => {
    clock = new TestClock();
    google = new TestIdentityProvider('google', [googleKey], clock.now);
    apple = new TestIdentityProvider('apple', [appleKey], clock.now);
    verifier = build();
    nonce = newNonce();
    googleExpected = {
      audiences: [GOOGLE_WEB_CLIENT, GOOGLE_MOBILE_CLIENT],
      nonce,
      allowHashedNonce: true,
    };
    appleExpected = {
      audiences: [APPLE_SERVICES_ID, APPLE_BUNDLE_ID],
      nonce,
      allowHashedNonce: true,
    };
  });

  const nowSeconds = (): number => Math.floor(clock.now().getTime() / 1000);

  async function failure(run: Promise<unknown>): Promise<OidcVerificationError> {
    try {
      await run;
    } catch (error) {
      if (error instanceof OidcVerificationError) return error;
      throw error;
    }
    throw new Error('expected the token to be refused, but it was accepted');
  }

  // ── accepted tokens ──

  it('FR-AUTH-002 / S-AUTH-9: accepts a correctly signed Google token and returns its identity', async () => {
    const token = await google.sign(googleKey, nonce, {
      subject: '1122334455',
      claims: { email: 'Ada@Example.test', email_verified: true, name: '  Ada Lovelace ' },
    });
    await expect(verifier.verify('google', token, googleExpected)).resolves.toEqual({
      provider: 'google',
      subject: '1122334455',
      email: 'Ada@Example.test',
      emailVerified: true,
      isPrivateEmail: false,
      name: 'Ada Lovelace',
    });
  });

  it('S-AUTH-9: accepts both documented spellings of the Google issuer', async () => {
    const token = await google.sign(googleKey, nonce, { issuer: 'accounts.google.com' });
    await expect(verifier.verify('google', token, googleExpected)).resolves.toMatchObject({
      provider: 'google',
    });
  });

  it('S-AUTH-9: accepts a token for any configured client ID (web or mobile)', async () => {
    const token = await google.sign(googleKey, nonce, { audience: GOOGLE_MOBILE_CLIENT });
    await expect(verifier.verify('google', token, googleExpected)).resolves.toMatchObject({
      subject: 'provider-user-1',
    });
  });

  it('FR-AUTH-002 / S-AUTH-9: Apple token with string "true" flags and a private-relay address', async () => {
    const token = await apple.sign(appleKey, nonce, {
      subject: '001234.abcdef.5678',
      audience: APPLE_BUNDLE_ID,
      claims: {
        email: 'x7k2@privaterelay.appleid.com',
        email_verified: 'true',
        is_private_email: 'true',
      },
    });
    await expect(verifier.verify('apple', token, appleExpected)).resolves.toEqual({
      provider: 'apple',
      subject: '001234.abcdef.5678',
      email: 'x7k2@privaterelay.appleid.com',
      emailVerified: true,
      isPrivateEmail: true,
      name: null,
    });
  });

  it('FR-AUTH-002: an Apple token without an email is valid and carries no email', async () => {
    const token = await apple.sign(appleKey, nonce, {
      claims: { email: undefined, email_verified: undefined },
    });
    await expect(verifier.verify('apple', token, appleExpected)).resolves.toMatchObject({
      email: null,
      emailVerified: false,
    });
  });

  it('S-AUTH-9: email_verified counts only when it is true or "true"', async () => {
    for (const value of [false, 'false', undefined, 1, 'TRUE', 'yes', null]) {
      const token = await google.sign(googleKey, nonce, { claims: { email_verified: value } });
      const identity = await verifier.verify('google', token, googleExpected);
      expect(identity.emailVerified, `email_verified=${String(value)}`).toBe(false);
      expect(identity.email).toBe('person@example.test');
    }
  });

  it('S-AUTH-9: a malformed email claim is treated as no email, never as a verified one', async () => {
    const token = await google.sign(googleKey, nonce, {
      claims: { email: 'not an email', email_verified: true },
    });
    await expect(verifier.verify('google', token, googleExpected)).resolves.toMatchObject({
      email: null,
      emailVerified: false,
    });
  });

  // ── nonce ──

  it('S-AUTH-9: a wrong nonce is refused', async () => {
    const token = await google.sign(googleKey, newNonce());
    const error = await failure(verifier.verify('google', token, googleExpected));
    expect(error.reason).toBe('invalid');
    expect(error.detail).toBe('nonce mismatch');
  });

  it('S-AUTH-9: a token without a nonce is refused', async () => {
    const token = await google.sign(googleKey, nonce, { nonce: undefined });
    expect((await failure(verifier.verify('google', token, googleExpected))).detail).toBe(
      'nonce mismatch',
    );
  });

  it('S-AUTH-9: the SHA-256 form of the nonce (Apple native) is accepted only when allowed', async () => {
    const token = await apple.sign(appleKey, nonce, { nonce: sha256Hex(nonce) });
    await expect(verifier.verify('apple', token, appleExpected)).resolves.toMatchObject({
      provider: 'apple',
    });
    const strict = { ...appleExpected, allowHashedNonce: false };
    expect((await failure(verifier.verify('apple', token, strict))).detail).toBe('nonce mismatch');
  });

  // ── audience and issuer ──

  it('S-AUTH-9: a token for another client (wrong aud) is refused', async () => {
    const token = await google.sign(googleKey, nonce, {
      audience: 'someone-else.apps.googleusercontent.test',
    });
    const error = await failure(verifier.verify('google', token, googleExpected));
    expect(error.reason).toBe('invalid');
    expect(error.detail).toBe('ERR_JWT_CLAIM_VALIDATION_FAILED:aud');
  });

  it('S-AUTH-9: the audience list given by the caller is the whole allow-list', async () => {
    // The web flow passes only the web client: a token for the mobile client must not pass.
    const token = await google.sign(googleKey, nonce, { audience: GOOGLE_MOBILE_CLIENT });
    const webOnly = { ...googleExpected, audiences: [GOOGLE_WEB_CLIENT] };
    expect((await failure(verifier.verify('google', token, webOnly))).reason).toBe('invalid');
  });

  it('S-AUTH-9: never verifies without an audience', async () => {
    const token = await google.sign(googleKey, nonce);
    const error = await failure(
      verifier.verify('google', token, { ...googleExpected, audiences: [] }),
    );
    expect(error.reason).toBe('invalid');
    expect(google.fetches).toBe(0);
  });

  it('S-AUTH-9: azp, when present, must be one of our clients; several audiences need azp', async () => {
    const foreignAzp = await google.sign(googleKey, nonce, {
      claims: { azp: 'someone-else.apps.googleusercontent.test' },
    });
    expect((await failure(verifier.verify('google', foreignAzp, googleExpected))).detail).toBe(
      'azp is not one of our clients',
    );

    const ourAzp = await google.sign(googleKey, nonce, { claims: { azp: GOOGLE_MOBILE_CLIENT } });
    await expect(verifier.verify('google', ourAzp, googleExpected)).resolves.toBeDefined();

    const shared = await google.sign(googleKey, nonce, {
      audience: [GOOGLE_WEB_CLIENT, 'someone-else.apps.googleusercontent.test'],
    });
    expect((await failure(verifier.verify('google', shared, googleExpected))).detail).toBe(
      'multiple audiences without azp',
    );
  });

  it('S-AUTH-9: a wrong issuer is refused', async () => {
    const token = await google.sign(googleKey, nonce, { issuer: 'https://accounts.evil.test' });
    const error = await failure(verifier.verify('google', token, googleExpected));
    expect(error.detail).toBe('ERR_JWT_CLAIM_VALIDATION_FAILED:iss');
  });

  it('S-AUTH-9: a genuine Google token is not accepted as an Apple token, or the reverse', async () => {
    const googleToken = await google.sign(googleKey, nonce, { audience: APPLE_SERVICES_ID });
    const appleToken = await apple.sign(appleKey, nonce, { audience: GOOGLE_WEB_CLIENT });
    expect((await failure(verifier.verify('apple', googleToken, appleExpected))).reason).toBe(
      'invalid',
    );
    expect((await failure(verifier.verify('google', appleToken, googleExpected))).reason).toBe(
      'invalid',
    );
  });

  // ── time ──

  it('S-AUTH-9: an expired ID token is refused; the allowed clock skew is one minute', async () => {
    const issuedAt = nowSeconds() - 7200;
    const expired = await google.sign(googleKey, nonce, { issuedAt, expiresAt: nowSeconds() - 61 });
    const error = await failure(verifier.verify('google', expired, googleExpected));
    expect(error.detail).toBe('ERR_JWT_EXPIRED:exp');

    const justExpired = await google.sign(googleKey, nonce, {
      issuedAt,
      expiresAt: nowSeconds() - (OIDC_CLOCK_SKEW_SECONDS - 5),
    });
    await expect(verifier.verify('google', justExpired, googleExpected)).resolves.toBeDefined();
  });

  it('S-AUTH-9: a valid token stops working once the clock passes its exp', async () => {
    const token = await google.sign(googleKey, nonce);
    await expect(verifier.verify('google', token, googleExpected)).resolves.toBeDefined();
    clock.advance((3600 + OIDC_CLOCK_SKEW_SECONDS + 1) * 1000);
    expect((await failure(verifier.verify('google', token, googleExpected))).reason).toBe(
      'invalid',
    );
  });

  it('S-AUTH-9: a token issued in the future is refused beyond the clock skew', async () => {
    const future = await google.sign(googleKey, nonce, { issuedAt: nowSeconds() + 120 });
    expect((await failure(verifier.verify('google', future, googleExpected))).detail).toBe(
      'ERR_JWT_CLAIM_VALIDATION_FAILED:iat',
    );
    const slightlyAhead = await google.sign(googleKey, nonce, { issuedAt: nowSeconds() + 30 });
    await expect(verifier.verify('google', slightlyAhead, googleExpected)).resolves.toBeDefined();
  });

  it('S-AUTH-9: a token older than a day is refused even if its exp is far away', async () => {
    const issuedAt = nowSeconds() - OIDC_MAX_TOKEN_AGE_SECONDS - 120;
    const old = await google.sign(googleKey, nonce, { issuedAt, expiresAt: nowSeconds() + 3600 });
    expect((await failure(verifier.verify('google', old, googleExpected))).reason).toBe('invalid');
  });

  it('S-AUTH-9: tokens without iat, exp or sub are refused', async () => {
    const base = { iss: 'https://accounts.google.com', aud: GOOGLE_WEB_CLIENT, nonce };
    const now = nowSeconds();
    const sign = (claims: Record<string, unknown>): Promise<string> =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: googleKey.kid })
        .sign(googleKey.privateKey);
    for (const claims of [
      { ...base, sub: 'u1', exp: now + 600 },
      { ...base, sub: 'u1', iat: now },
      { ...base, iat: now, exp: now + 600 },
      { ...base, sub: '', iat: now, exp: now + 600 },
    ]) {
      const error = await failure(verifier.verify('google', await sign(claims), googleExpected));
      expect(error.reason).toBe('invalid');
    }
  });

  // ── signature and algorithm ──

  it('S-AUTH-9: alg=none is refused before any key is fetched', async () => {
    const header = b64url(JSON.stringify({ alg: 'none', typ: 'JWT', kid: googleKey.kid }));
    const now = nowSeconds();
    const payload = b64url(
      JSON.stringify({
        iss: 'https://accounts.google.com',
        aud: GOOGLE_WEB_CLIENT,
        sub: 'attacker',
        email: 'victim@example.test',
        email_verified: true,
        nonce,
        iat: now,
        exp: now + 600,
      }),
    );
    for (const token of [`${header}.${payload}.`, `${header}.${payload}.AAAA`]) {
      const error = await failure(verifier.verify('google', token, googleExpected));
      expect(error.reason).toBe('invalid');
    }
    expect(google.fetches).toBe(0);
  });

  it('S-AUTH-9: an HMAC token keyed with the public key (algorithm confusion) is refused', async () => {
    const publicPem = createPublicKey({ key: googleKey.publicJwk, format: 'jwk' }).export({
      type: 'spki',
      format: 'pem',
    });
    const now = nowSeconds();
    const forged = await new SignJWT({ nonce, email: 'victim@example.test', email_verified: true })
      .setProtectedHeader({ alg: 'HS256', kid: googleKey.kid })
      .setIssuer('https://accounts.google.com')
      .setAudience(GOOGLE_WEB_CLIENT)
      .setSubject('attacker')
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(Buffer.from(publicPem));
    const error = await failure(verifier.verify('google', forged, googleExpected));
    expect(error.reason).toBe('invalid');
    expect(error.detail).toBe('ERR_JOSE_ALG_NOT_ALLOWED');
    expect(google.fetches).toBe(0);
  });

  it('S-AUTH-9: a token signed with a different key under the same kid is refused', async () => {
    const forged = await google.sign(strangerKey, nonce);
    const error = await failure(verifier.verify('google', forged, googleExpected));
    expect(error.reason).toBe('invalid');
    expect(error.detail).toBe('ERR_JWS_SIGNATURE_VERIFICATION_FAILED');
  });

  it('S-AUTH-9: a token whose payload was changed after signing is refused', async () => {
    const token = await google.sign(googleKey, nonce, { subject: 'honest-user' });
    const [header, payload, signature] = token.split('.') as [string, string, string];
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    const tampered = `${header}.${b64url(JSON.stringify({ ...claims, sub: 'someone-else' }))}.${signature}`;
    expect((await failure(verifier.verify('google', tampered, googleExpected))).detail).toBe(
      'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
    );
  });

  it('S-AUTH-9: garbage and oversized input are refused without fetching keys', async () => {
    for (const token of ['', 'not-a-jwt', 'a.b.c', `${'a'.repeat(9000)}.b.c`]) {
      expect((await failure(verifier.verify('google', token, googleExpected))).reason).toBe(
        'invalid',
      );
    }
    expect(google.fetches).toBe(0);
  });

  // ── keys: caching, rotation, outage ──

  it('S-AUTH-9: the key set is fetched once and reused', async () => {
    for (let index = 0; index < 3; index += 1) {
      const token = await google.sign(googleKey, nonce, { subject: `user-${index}` });
      await verifier.verify('google', token, googleExpected);
    }
    expect(google.fetches).toBe(1);
    expect(apple.fetches).toBe(0);
  });

  it('S-AUTH-9: JWKS kid rotation: a token signed with a newly published key is accepted after a refetch', async () => {
    verifier = build(0); // no cooldown, so the refetch may happen at once
    await verifier.verify('google', await google.sign(googleKey, nonce), googleExpected);
    expect(google.fetches).toBe(1);

    const rotated = generateRsaSigningKey('google-key-2');
    google.published = [rotated]; // the old key is withdrawn
    const fresh = await google.sign(rotated, nonce);
    await expect(verifier.verify('google', fresh, googleExpected)).resolves.toMatchObject({
      provider: 'google',
    });
    expect(google.fetches).toBe(2);

    // Tokens signed with the withdrawn key no longer verify.
    const stale = await google.sign(googleKey, nonce);
    expect((await failure(verifier.verify('google', stale, googleExpected))).reason).toBe(
      'invalid',
    );
  });

  it('S-AUTH-9: unknown kids cannot make the server refetch keys more than once per cooldown', async () => {
    await verifier.verify('google', await google.sign(googleKey, nonce), googleExpected);
    expect(google.fetches).toBe(1);
    for (let index = 0; index < 5; index += 1) {
      const token = await google.sign(googleKey, nonce, { kid: `made-up-${index}` });
      const error = await failure(verifier.verify('google', token, googleExpected));
      expect(error.reason).toBe('invalid');
      expect(error.detail).toBe('no key with the token kid');
    }
    expect(google.fetches).toBe(1);
  });

  it('S-AUTH-9: when the key set cannot be fetched the result is "unavailable", never "accepted"', async () => {
    for (const mode of ['http_500', 'network_error', 'not_json'] as const) {
      google.mode = mode;
      verifier = build();
      const token = await google.sign(googleKey, nonce);
      const error = await failure(verifier.verify('google', token, googleExpected));
      expect(error.reason, mode).toBe('unavailable');
    }
    // The provider recovers: the same verifier works again.
    google.mode = 'ok';
    await expect(
      verifier.verify('google', await google.sign(googleKey, nonce), googleExpected),
    ).resolves.toBeDefined();
  });

  it('S-AUTH-9: failures never carry token material', async () => {
    const token = await google.sign(strangerKey, nonce);
    const error = await failure(verifier.verify('google', token, googleExpected));
    const [, payload, signature] = token.split('.') as [string, string, string];
    for (const text of [error.message, error.detail]) {
      expect(text).not.toContain(payload);
      expect(text).not.toContain(signature);
      expect(text).not.toContain(nonce);
    }
  });
});
