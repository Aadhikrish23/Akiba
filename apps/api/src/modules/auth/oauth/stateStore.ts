import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { OAuthProvider } from '@akiba/shared';
import type { DbClient } from '../../../db/index.js';

/**
 * Server-side record of a started web sign-in (doc 09 S-AUTH-9: `state` and `nonce` validated).
 *
 * - `state` is 32 bytes from the OS CSPRNG, base64url. Only its SHA-256 is stored.
 * - `nonce` is made here too and goes to the provider; the ID token must carry it back. The
 *   browser never needs it.
 * - The PKCE verifier is made and kept by the browser; only its S256 challenge is stored. To
 *   finish, the caller must present the verifier, so the request can only be completed by the
 *   browser that started it. That is what ties a `state` to a user agent (no cookie involved),
 *   and it is why a `state` planted by an attacker (login CSRF) cannot be completed by a victim.
 * - A record works once and for {@link OAUTH_STATE_LIFETIME_MS}. Presenting a `state` uses it
 *   up even if the rest of the request is wrong.
 */

export const OAUTH_STATE_LIFETIME_MS = 10 * 60 * 1000;

const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const sha256 = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

export const hashOAuthState = (state: string): string => sha256(state).toString('hex');

/** PKCE S256: `BASE64URL(SHA256(verifier))` (RFC 7636 §4.2). */
export const pkceChallenge = (verifier: string): string => sha256(verifier).toString('base64url');

export interface StartedOAuthState {
  /** The raw value. Goes to the browser and the provider; never stored or logged. */
  readonly state: string;
  readonly nonce: string;
  readonly expiresAt: Date;
}

export interface OAuthStateClaim {
  readonly provider: OAuthProvider;
  readonly redirectUri: string;
  readonly codeVerifier: string;
}

export class OAuthStateStore {
  readonly #db: DbClient;
  readonly #now: () => Date;

  constructor(options: { db: DbClient; now: () => Date }) {
    this.#db = options.db;
    this.#now = options.now;
  }

  async create(input: {
    provider: OAuthProvider;
    redirectUri: string;
    codeChallenge: string;
  }): Promise<StartedOAuthState> {
    const now = this.#now();
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + OAUTH_STATE_LIFETIME_MS);
    await this.#db.$transaction([
      // Housekeeping on every start keeps the table at "attempts of the last ten minutes".
      this.#db.oAuthState.deleteMany({ where: { expiresAt: { lte: now } } }),
      this.#db.oAuthState.create({
        data: {
          stateHash: hashOAuthState(state),
          provider: input.provider,
          nonce,
          codeChallenge: input.codeChallenge,
          redirectUri: input.redirectUri,
          expiresAt,
        },
      }),
    ]);
    return { state, nonce, expiresAt };
  }

  /**
   * Use a `state`. Returns the nonce the ID token must carry, or `null` for every failure
   * (unknown, malformed, expired, already used, other provider, other redirect URI, wrong PKCE
   * verifier); callers must not tell those apart to the client.
   *
   * Atomic: one `UPDATE … WHERE used_at IS NULL` claims the row, so of any number of concurrent
   * requests with the same `state` at most one gets past this point.
   */
  async consume(presented: string, claim: OAuthStateClaim): Promise<{ nonce: string } | null> {
    const stateHash = hashOAuthState(presented);
    if (!STATE_PATTERN.test(presented)) return null;
    const now = this.#now();
    const claimed = await this.#db.oAuthState.updateManyAndReturn({
      where: { stateHash, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
      select: { provider: true, nonce: true, codeChallenge: true, redirectUri: true },
    });
    const record = claimed[0];
    if (record === undefined) return null;
    const verifierMatches = timingSafeEqual(
      sha256(pkceChallenge(claim.codeVerifier)),
      sha256(record.codeChallenge),
    );
    if (
      record.provider !== claim.provider ||
      record.redirectUri !== claim.redirectUri ||
      !verifierMatches
    ) {
      return null;
    }
    return { nonce: record.nonce };
  }
}
