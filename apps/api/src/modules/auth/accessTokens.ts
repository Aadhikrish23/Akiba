import { generateKeyPairSync } from 'node:crypto';
import {
  calculateJwkThumbprint,
  importJWK,
  jwtVerify,
  SignJWT,
  type CryptoKey,
  type JWTHeaderParameters,
} from 'jose';
import { z } from 'zod';
import type { Ed25519Jwk } from '../../config/env.js';

/**
 * The ONLY signature algorithm accepted or produced (doc 09 S-AUTH-5). It is passed to the
 * verifier as an allow-list of one, so `none`, HS256 and anything else are refused before any
 * key is looked at.
 */
export const ACCESS_TOKEN_ALGORITHM = 'EdDSA';

export interface AccessTokenClaims {
  /** User ID. */
  readonly userId: string;
  /** Session ID = refresh-token family ID. Revoking the family ends the session. */
  readonly sessionId: string;
}

export interface IssuedAccessToken {
  readonly token: string;
  readonly expiresInSeconds: number;
}

/** Seam for issuing and checking access tokens (S-AUTH-12). */
export interface AccessTokenService {
  issue(claims: AccessTokenClaims): Promise<IssuedAccessToken>;
  /**
   * Returns the claims of a token that is authentic, unexpired and meant for this API, otherwise
   * `null`. Deliberately gives no reason: callers answer every failure with the same 401.
   */
  verify(token: string): Promise<AccessTokenClaims | null>;
}

export interface AccessTokenKeys {
  readonly signing: { readonly kid: string; readonly privateKey: CryptoKey };
  /** Public keys by `kid`: the current one plus, during a rotation, the previous one. */
  readonly verification: ReadonlyMap<string, CryptoKey>;
  /** True when no key was configured and one was generated for this process only. */
  readonly ephemeral: boolean;
}

const publicPart = (jwk: Ed25519Jwk): Ed25519Jwk => ({
  kty: jwk.kty,
  crv: jwk.crv,
  x: jwk.x,
  kid: jwk.kid,
});

async function importEd25519(jwk: Ed25519Jwk): Promise<CryptoKey> {
  const key = await importJWK({ ...jwk }, ACCESS_TOKEN_ALGORITHM, { extractable: false });
  if (key instanceof Uint8Array) throw new Error('expected an asymmetric key');
  return key;
}

/** A fresh Ed25519 key pair as a private JWK whose `kid` is its RFC 7638 thumbprint. */
export async function generateSigningJwk(): Promise<Ed25519Jwk> {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || jwk.x === undefined || jwk.d === undefined) {
    throw new Error('unexpected key export');
  }
  const kid = await calculateJwkThumbprint({ kty: 'OKP', crv: 'Ed25519', x: jwk.x }, 'sha256');
  return { kty: 'OKP', crv: 'Ed25519', x: jwk.x, d: jwk.d, kid };
}

/**
 * Load the signing key and the verification keys.
 *
 * Rotation: generate a new key, set it as `AUTH_JWT_PRIVATE_JWK` and move the PUBLIC half of the
 * old one to `AUTH_JWT_PREVIOUS_PUBLIC_JWK`; tokens signed with the old key stay valid until they
 * expire (15 minutes), after which the previous key can be removed.
 */
export async function loadAccessTokenKeys(config: {
  readonly privateJwk: Ed25519Jwk | undefined;
  readonly previousPublicJwk: Ed25519Jwk | undefined;
}): Promise<AccessTokenKeys> {
  const ephemeral = config.privateJwk === undefined;
  const current = config.privateJwk ?? (await generateSigningJwk());
  if (current.d === undefined) throw new Error('the signing key has no private part');

  const verification = new Map<string, CryptoKey>();
  verification.set(current.kid, await importEd25519(publicPart(current)));
  if (config.previousPublicJwk !== undefined) {
    verification.set(
      config.previousPublicJwk.kid,
      await importEd25519(publicPart(config.previousPublicJwk)),
    );
  }
  return {
    signing: { kid: current.kid, privateKey: await importEd25519(current) },
    verification,
    ephemeral,
  };
}

const claimsSchema = z.object({ sub: z.uuid(), sid: z.uuid() });

export interface JwtAccessTokenOptions {
  readonly keys: AccessTokenKeys;
  readonly issuer: string;
  readonly audience: string;
  readonly lifetimeSeconds: number;
  readonly now: () => Date;
}

/**
 * JWT access tokens (doc 09 S-AUTH-5) built on `jose`: EdDSA only, `kid` in the header, claims
 * `iss`, `aud`, `sub`, `sid`, `iat`, `exp`. The claims carry identifiers only, no personal data.
 */
export class JwtAccessTokenService implements AccessTokenService {
  readonly #options: JwtAccessTokenOptions;

  constructor(options: JwtAccessTokenOptions) {
    this.#options = options;
  }

  async issue(claims: AccessTokenClaims): Promise<IssuedAccessToken> {
    const { keys, issuer, audience, lifetimeSeconds, now } = this.#options;
    const issuedAt = Math.floor(now().getTime() / 1000);
    const token = await new SignJWT({ sid: claims.sessionId })
      .setProtectedHeader({ alg: ACCESS_TOKEN_ALGORITHM, typ: 'JWT', kid: keys.signing.kid })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(claims.userId)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + lifetimeSeconds)
      .sign(keys.signing.privateKey);
    return { token, expiresInSeconds: lifetimeSeconds };
  }

  async verify(token: string): Promise<AccessTokenClaims | null> {
    const { keys, issuer, audience, now } = this.#options;
    try {
      const { payload } = await jwtVerify(
        token,
        // Key selection is by `kid` only: a token without one, or naming a key this server does
        // not hold, cannot be verified. The key is never chosen from the token's `alg`.
        (header: JWTHeaderParameters) => {
          const key = header.kid === undefined ? undefined : keys.verification.get(header.kid);
          if (key === undefined) throw new Error('unknown key');
          return key;
        },
        {
          algorithms: [ACCESS_TOKEN_ALGORITHM],
          issuer,
          audience,
          typ: 'JWT',
          requiredClaims: ['iss', 'aud', 'sub', 'sid', 'iat', 'exp'],
          currentDate: now(),
          clockTolerance: 0,
        },
      );
      const claims = claimsSchema.safeParse(payload);
      if (!claims.success) return null;
      return { userId: claims.data.sub, sessionId: claims.data.sid };
    } catch {
      return null;
    }
  }
}
