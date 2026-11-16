import { createHash, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import type { OAuthProvider } from '@akiba/shared';
import { SignJWT, type JWK } from 'jose';
import type {
  CodeExchangeRequest,
  OAuthCodeExchanger,
} from '../modules/auth/oauth/codeExchanger.js';
import { OAuthCodeExchangeError } from '../modules/auth/oauth/codeExchanger.js';
import {
  nonceMatches,
  OidcVerificationError,
  type OidcExpectations,
  type OidcIdentity,
  type OidcVerifier,
} from '../modules/auth/oauth/oidcVerifier.js';
import { PROVIDER_PROFILES } from '../modules/auth/oauth/providers.js';
import { pkceChallenge } from '../modules/auth/oauth/stateStore.js';

/** Client IDs the test app is configured with. The first of each is the web client. */
export const GOOGLE_WEB_CLIENT = 'web-client.apps.googleusercontent.test';
export const GOOGLE_MOBILE_CLIENT = 'android-client.apps.googleusercontent.test';
export const APPLE_SERVICES_ID = 'test.akiba.web';
export const APPLE_BUNDLE_ID = 'test.akiba.app';
export const OAUTH_REDIRECT_URI = 'https://app.akiba.test/oauth/callback';

/** THROWAWAY values for tests only; they open nothing anywhere. */
export const TEST_GOOGLE_CLIENT_SECRET = 'throwaway-google-client-secret-for-tests';

/** A fresh EC P-256 key as Apple would issue it (`.p8`, PKCS#8 PEM). Generated per call. */
export function generateApplePrivateKeyPem(): { pem: string; publicKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).trim(), publicKey };
}

/** Environment that switches both providers on, web flow included. */
export function oauthTestEnv(): Record<string, string> {
  return {
    GOOGLE_CLIENT_IDS: `${GOOGLE_WEB_CLIENT},${GOOGLE_MOBILE_CLIENT}`,
    GOOGLE_CLIENT_SECRET: TEST_GOOGLE_CLIENT_SECRET,
    APPLE_CLIENT_IDS: `${APPLE_SERVICES_ID},${APPLE_BUNDLE_ID}`,
    APPLE_TEAM_ID: 'TEAM123456',
    APPLE_KEY_ID: 'KEY1234567',
    APPLE_PRIVATE_KEY: generateApplePrivateKeyPem().pem.replace(/\n/g, '\\n'),
    OAUTH_REDIRECT_URIS: OAUTH_REDIRECT_URI,
  };
}

export const newNonce = (): string => randomBytes(32).toString('base64url');

/** A PKCE pair as a browser would make it. */
export function newPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: pkceChallenge(verifier) };
}

export interface FakeTokenClaims {
  readonly provider: OAuthProvider;
  readonly subject: string;
  readonly email?: string | null;
  readonly emailVerified?: boolean;
  readonly isPrivateEmail?: boolean;
  readonly name?: string | null;
  /** The nonce in the token (what the client gave the provider). */
  readonly nonce: string;
  /** Defaults to the provider's first configured client. */
  readonly audience?: string;
}

const DEFAULT_AUDIENCE: Record<OAuthProvider, string> = {
  google: GOOGLE_WEB_CLIENT,
  apple: APPLE_SERVICES_ID,
};

/**
 * Stand-in for the JWKS verifier in FLOW tests: it "verifies" tokens it issued itself and
 * applies the same audience and nonce rules. Signature, issuer and expiry checks are the real
 * verifier's job and are tested against real signatures in `oidcVerifier.test.ts`.
 */
export class FakeOidcVerifier implements OidcVerifier {
  readonly #tokens = new Map<string, FakeTokenClaims>();
  /** Every call, for asserting what the flows asked the verifier to check. */
  readonly calls: { provider: OAuthProvider; idToken: string; expected: OidcExpectations }[] = [];
  /** Set to make the next verifications fail as if the provider's keys were unreachable. */
  unavailable = false;

  /** An opaque "ID token" that this verifier will accept for exactly these claims. */
  issue(claims: FakeTokenClaims): string {
    const token = `fake-id-token.${randomBytes(24).toString('base64url')}`;
    this.#tokens.set(token, claims);
    return token;
  }

  verify(
    provider: OAuthProvider,
    idToken: string,
    expected: OidcExpectations,
  ): Promise<OidcIdentity> {
    this.calls.push({ provider, idToken, expected });
    return new Promise((resolve, reject) => {
      if (this.unavailable) {
        reject(new OidcVerificationError('unavailable', 'fake outage'));
        return;
      }
      const claims = this.#tokens.get(idToken);
      if (claims === undefined || claims.provider !== provider) {
        reject(new OidcVerificationError('invalid', 'unknown token'));
        return;
      }
      if (!expected.audiences.includes(claims.audience ?? DEFAULT_AUDIENCE[provider])) {
        reject(new OidcVerificationError('invalid', 'audience'));
        return;
      }
      if (!nonceMatches(claims.nonce, expected)) {
        reject(new OidcVerificationError('invalid', 'nonce mismatch'));
        return;
      }
      const email = claims.email ?? null;
      resolve({
        provider,
        subject: claims.subject,
        email,
        emailVerified: email !== null && (claims.emailVerified ?? true),
        isPrivateEmail: claims.isPrivateEmail ?? false,
        name: claims.name ?? null,
      });
    });
  }
}

/**
 * Stand-in for the provider's token endpoint in flow tests. A code is registered together with
 * the PKCE challenge and redirect URI of "its" authorization request and, like a real provider,
 * is refused when the verifier or the redirect URI does not match, and when used twice.
 */
export class FakeCodeExchanger implements OAuthCodeExchanger {
  readonly #codes = new Map<
    string,
    { provider: OAuthProvider; idToken: string; codeChallenge: string; redirectUri: string }
  >();
  readonly calls: { provider: OAuthProvider; request: CodeExchangeRequest }[] = [];
  unavailable = false;

  /** A code the "provider" will swap for `idToken`. */
  issueCode(input: {
    provider: OAuthProvider;
    idToken: string;
    codeChallenge: string;
    redirectUri?: string;
  }): string {
    const code = `fake-code.${randomBytes(24).toString('base64url')}`;
    this.#codes.set(code, { redirectUri: OAUTH_REDIRECT_URI, ...input });
    return code;
  }

  exchange(provider: OAuthProvider, request: CodeExchangeRequest): Promise<{ idToken: string }> {
    this.calls.push({ provider, request });
    return new Promise((resolve, reject) => {
      if (this.unavailable) {
        reject(new OAuthCodeExchangeError('unavailable', 'fake outage'));
        return;
      }
      const entry = this.#codes.get(request.code);
      this.#codes.delete(request.code);
      if (
        entry === undefined ||
        entry.provider !== provider ||
        entry.redirectUri !== request.redirectUri ||
        entry.codeChallenge !== pkceChallenge(request.codeVerifier)
      ) {
        reject(new OAuthCodeExchangeError('rejected', 'invalid_grant'));
        return;
      }
      resolve({ idToken: entry.idToken });
    });
  }
}

// ── A pretend identity provider with real keys, for testing the REAL verifier offline ──

export interface TestSigningKey {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly publicJwk: JWK;
}

/** A fresh RSA-2048 signing key, as Google and Apple use. Slow-ish (tens of ms); make few. */
export function generateRsaSigningKey(kid: string): TestSigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    kid,
    privateKey,
    publicJwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' },
  };
}

export interface IdTokenOverrides {
  readonly issuer?: string;
  readonly audience?: string | string[];
  readonly subject?: string;
  readonly nonce?: string | undefined;
  /** Seconds since the epoch. */
  readonly issuedAt?: number;
  readonly expiresAt?: number;
  readonly kid?: string | undefined;
  readonly claims?: Record<string, unknown>;
}

/**
 * Signs ID tokens the way a provider does and serves its key set through a `fetch` stand-in,
 * all in-process: no socket is opened and no provider is contacted.
 */
export class TestIdentityProvider {
  readonly provider: OAuthProvider;
  /** Keys currently published in the key set. */
  published: TestSigningKey[];
  /** How many times the key set was downloaded. */
  fetches = 0;
  /** `ok`: serve the keys. Anything else simulates an outage of that kind. */
  mode: 'ok' | 'http_500' | 'network_error' | 'not_json' = 'ok';
  readonly #now: () => Date;

  constructor(provider: OAuthProvider, keys: TestSigningKey[], now: () => Date) {
    this.provider = provider;
    this.published = keys;
    this.#now = now;
  }

  /** Give this to the verifier as its `fetch`. Refuses every URL but the provider's key set. */
  readonly fetch = (url: string): Promise<Response> => {
    if (url !== PROVIDER_PROFILES[this.provider].jwksUri) {
      return Promise.reject(new Error(`unexpected request to ${url}`));
    }
    this.fetches += 1;
    if (this.mode === 'network_error') return Promise.reject(new TypeError('fetch failed'));
    if (this.mode === 'http_500') return Promise.resolve(new Response('oops', { status: 500 }));
    if (this.mode === 'not_json') return Promise.resolve(new Response('<html>', { status: 200 }));
    const body = JSON.stringify({ keys: this.published.map((key) => key.publicJwk) });
    return Promise.resolve(
      new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
  };

  /** A correctly signed ID token; every part can be overridden to make a wrong one. */
  async sign(key: TestSigningKey, nonce: string, overrides: IdTokenOverrides = {}): Promise<string> {
    const nowSeconds = Math.floor(this.#now().getTime() / 1000);
    const issuedAt = overrides.issuedAt ?? nowSeconds;
    const tokenNonce = 'nonce' in overrides ? overrides.nonce : nonce;
    const kid = 'kid' in overrides ? overrides.kid : key.kid;
    return new SignJWT({
      ...(tokenNonce === undefined ? {} : { nonce: tokenNonce }),
      email: 'person@example.test',
      email_verified: true,
      ...overrides.claims,
    })
      .setProtectedHeader({ alg: 'RS256', ...(kid === undefined ? {} : { kid }) })
      .setIssuer(overrides.issuer ?? (PROVIDER_PROFILES[this.provider].issuers[0] as string))
      .setAudience(overrides.audience ?? DEFAULT_AUDIENCE[this.provider])
      .setSubject(overrides.subject ?? 'provider-user-1')
      .setIssuedAt(issuedAt)
      .setExpirationTime(overrides.expiresAt ?? issuedAt + 3600)
      .sign(key.privateKey);
  }
}

export const sha256Hex = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

/** base64url without padding, for hand-built (forged) tokens. */
export const b64url = (value: string | Buffer): string => Buffer.from(value).toString('base64url');
