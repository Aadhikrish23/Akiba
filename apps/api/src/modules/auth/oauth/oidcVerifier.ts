import { createHash, timingSafeEqual } from 'node:crypto';
import { EMAIL_MAX_LENGTH, type OAuthProvider } from '@akiba/shared';
import {
  createRemoteJWKSet,
  customFetch,
  errors as joseErrors,
  jwtVerify,
  type JWTVerifyGetKey,
} from 'jose';
import { z } from 'zod';
import { PROVIDER_PROFILES } from './providers.js';

/** Who the provider says is signing in. Nothing here is trusted beyond what the provider signed. */
export interface OidcIdentity {
  readonly provider: OAuthProvider;
  /** The provider's stable user ID (`sub`). The ONLY key an identity is stored and found by. */
  readonly subject: string;
  /** Absent when the provider sent none (Apple may omit it after the first authorization). */
  readonly email: string | null;
  /** True only when the provider asserts it (`true`, or the string `"true"` Apple sends). */
  readonly emailVerified: boolean;
  /** Apple "Hide My Email" relay address. A real, deliverable address; accepted like any other. */
  readonly isPrivateEmail: boolean;
  /** Display name, when the provider puts one in the token (Google). */
  readonly name: string | null;
}

export interface OidcExpectations {
  /** Client IDs of this deployment. `aud` must be one of them (and `azp`, when present). */
  readonly audiences: readonly string[];
  /** The nonce made for this sign-in. */
  readonly nonce: string;
  /**
   * Also accept a token whose `nonce` is the SHA-256 (hex) of {@link nonce}: Apple's native API
   * is given the hash and puts the hash in the token, while the app sends the raw value here.
   * False for the web flow, where this server made the nonce and sent it to the provider as is.
   */
  readonly allowHashedNonce: boolean;
}

export type OidcFailure =
  /** The token is not acceptable. Every such case gets the same answer; `detail` is for logs. */
  | 'invalid'
  /** The provider's keys could not be fetched: nothing can be said about the token. */
  | 'unavailable';

export class OidcVerificationError extends Error {
  readonly reason: OidcFailure;
  /** Which check failed; never contains token material. For server logs only. */
  readonly detail: string;

  constructor(reason: OidcFailure, detail: string, cause?: unknown) {
    super(`ID token ${reason}: ${detail}`, cause === undefined ? undefined : { cause });
    this.name = 'OidcVerificationError';
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * Seam for checking a provider's ID token (doc 09 S-AUTH-9, S-AUTH-12). The flows depend on this
 * interface only; tests of the flows use a fake, the real one is {@link JwksOidcVerifier}.
 */
export interface OidcVerifier {
  /** Resolves with the identity of a fully verified token; rejects with {@link OidcVerificationError}. */
  verify(
    provider: OAuthProvider,
    idToken: string,
    expected: OidcExpectations,
  ): Promise<OidcIdentity>;
}

/** Allowed clock difference between this server and the provider. */
export const OIDC_CLOCK_SKEW_SECONDS = 60;
/** No ID token older than this is accepted, whatever its `exp` says. */
export const OIDC_MAX_TOKEN_AGE_SECONDS = 24 * 60 * 60;
/** Bounds the work spent on garbage; real ID tokens are 1 to 2 KB. */
const MAX_ID_TOKEN_LENGTH = 8192;

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/** Compare without revealing where two strings differ (both sides are hashed to equal length). */
function sameString(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

/** Does the token's `nonce` belong to the nonce made for this sign-in? */
export function nonceMatches(
  tokenNonce: unknown,
  expected: Pick<OidcExpectations, 'nonce' | 'allowHashedNonce'>,
): boolean {
  if (typeof tokenNonce !== 'string' || tokenNonce === '' || expected.nonce === '') return false;
  if (sameString(tokenNonce, expected.nonce)) return true;
  return (
    expected.allowHashedNonce && sameString(tokenNonce, digest(expected.nonce).toString('hex'))
  );
}

const emailClaim = z.string().trim().max(EMAIL_MAX_LENGTH).pipe(z.email());
/** Providers send booleans; Apple has sent the strings "true"/"false". Anything else is false. */
const asserted = (value: unknown): boolean => value === true || value === 'true';

function displayName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const name = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return name === '' ? null : [...name].slice(0, 50).join('');
}

/** Network or provider trouble while fetching keys, as opposed to a bad token. */
function isKeyFetchFailure(error: unknown): boolean {
  if (error instanceof joseErrors.JWKSTimeout || error instanceof joseErrors.JWKSInvalid) {
    return true;
  }
  // jose reports a non-200 key response as a bare JOSEError; token problems use subclasses.
  if (error instanceof joseErrors.JOSEError) return error.constructor === joseErrors.JOSEError;
  // Anything that is not a JOSE error came from the transport (DNS, TLS, connection reset).
  return true;
}

export interface JwksOidcVerifierOptions {
  readonly now: () => Date;
  /**
   * Key lookup per provider. Defaults to the provider's published JWKS, fetched over HTTPS and
   * cached. Tests pass a resolver over keys generated in the test; nothing in CI calls a provider.
   */
  readonly keys?: Partial<Record<OAuthProvider, JWTVerifyGetKey>>;
  /** Milliseconds one key download may take. */
  readonly fetchTimeoutMs?: number;
  /** Minimum milliseconds between two key downloads caused by unknown `kid`s. Default 30 s. */
  readonly refetchCooldownMs?: number;
  /** Replaces the global `fetch` for key downloads (tests serve a key set in-process). */
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

/**
 * Verifies Google and Apple ID tokens against the provider's signing keys with `jose`.
 *
 * Checked, in this order: the size; the signature algorithm (allow-list of one, so `none` and
 * HMAC are refused before any key is looked at); the signature, with the key named by `kid`;
 * `iss`; `aud` (one of this deployment's client IDs); `exp`; `iat` (not in the future, not older
 * than a day); `azp` when present; `sub`; `nonce`. Email claims are read only after all of that.
 *
 * Keys: `createRemoteJWKSet` caches the provider's key set (10 minutes) and downloads it again
 * when a token names a `kid` it does not know (a provider rotating keys), at most once every 30
 * seconds, so unknown `kid`s cannot be used to make this server hammer the provider.
 */
export class JwksOidcVerifier implements OidcVerifier {
  readonly #now: () => Date;
  readonly #keys: Record<OAuthProvider, JWTVerifyGetKey>;

  constructor(options: JwksOidcVerifierOptions) {
    this.#now = options.now;
    const remote = (provider: OAuthProvider): JWTVerifyGetKey =>
      createRemoteJWKSet(new URL(PROVIDER_PROFILES[provider].jwksUri), {
        timeoutDuration: options.fetchTimeoutMs ?? 3_000,
        cooldownDuration: options.refetchCooldownMs ?? 30_000,
        cacheMaxAge: 10 * 60_000,
        ...(options.fetch === undefined ? {} : { [customFetch]: options.fetch }),
      });
    // Creating a remote set does not fetch anything; the first verification does.
    this.#keys = {
      google: options.keys?.google ?? remote('google'),
      apple: options.keys?.apple ?? remote('apple'),
    };
  }

  async verify(
    provider: OAuthProvider,
    idToken: string,
    expected: OidcExpectations,
  ): Promise<OidcIdentity> {
    const profile = PROVIDER_PROFILES[provider];
    if (expected.audiences.length === 0) {
      // jose would skip the audience check for an empty list. Never verify without one.
      throw new OidcVerificationError('invalid', 'no audience configured');
    }
    if (idToken.length > MAX_ID_TOKEN_LENGTH) {
      throw new OidcVerificationError('invalid', 'token too long');
    }

    let payload;
    try {
      ({ payload } = await jwtVerify(idToken, this.#keys[provider], {
        algorithms: [...profile.algorithms],
        issuer: [...profile.issuers],
        audience: [...expected.audiences],
        requiredClaims: ['iss', 'aud', 'sub', 'iat', 'exp'],
        currentDate: this.#now(),
        clockTolerance: OIDC_CLOCK_SKEW_SECONDS,
        maxTokenAge: OIDC_MAX_TOKEN_AGE_SECONDS,
      }));
    } catch (error) {
      if (error instanceof joseErrors.JWKSNoMatchingKey) {
        throw new OidcVerificationError('invalid', 'no key with the token kid', error);
      }
      if (isKeyFetchFailure(error)) {
        throw new OidcVerificationError('unavailable', 'signing keys could not be fetched', error);
      }
      const code = error instanceof joseErrors.JOSEError ? error.code : 'unknown';
      const claim =
        error instanceof joseErrors.JWTClaimValidationFailed ||
        error instanceof joseErrors.JWTExpired
          ? `:${error.claim}`
          : '';
      throw new OidcVerificationError('invalid', `${code}${claim}`, error);
    }

    // A token for several audiences must say which client asked for it, and when it says so
    // (Google does on Android), that client must be one of ours too (OIDC Core §3.1.3.7).
    const { azp } = payload;
    if (Array.isArray(payload.aud) && payload.aud.length > 1 && azp === undefined) {
      throw new OidcVerificationError('invalid', 'multiple audiences without azp');
    }
    if (azp !== undefined && (typeof azp !== 'string' || !expected.audiences.includes(azp))) {
      throw new OidcVerificationError('invalid', 'azp is not one of our clients');
    }

    const subject = payload.sub;
    if (subject === undefined || subject === '' || subject.length > 255) {
      throw new OidcVerificationError('invalid', 'unusable sub');
    }
    if (!nonceMatches(payload['nonce'], expected)) {
      throw new OidcVerificationError('invalid', 'nonce mismatch');
    }

    const email = emailClaim.safeParse(payload['email']);
    return {
      provider,
      subject,
      email: email.success ? email.data : null,
      emailVerified: email.success && asserted(payload['email_verified']),
      isPrivateEmail: asserted(payload['is_private_email']),
      name: displayName(payload['name']),
    };
  }
}
