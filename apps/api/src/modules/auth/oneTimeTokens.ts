import { createHash, randomBytes } from 'node:crypto';
import { ONE_TIME_TOKEN } from '../../config/constants.js';
import type { DbClient, DbTransaction } from '../../db/index.js';

/**
 * One-time tokens for emailed links (doc 09 S-AUTH-10).
 *
 * - A token is 32 bytes from the OS CSPRNG, base64url (256 bits; the spec asks for ≥ 128). Only
 *   its SHA-256 is stored, so the table is useless to someone who reads it. A fast hash is
 *   enough because there is nothing to guess: the input is already 256 random bits.
 * - A token belongs to one user, has one purpose and one deadline, and can be used once.
 * - Issuing a token removes the user's earlier unused tokens of the same purpose: only the
 *   newest link works.
 * - `sentTo` is the address the link was emailed to. Using the token proves control of THAT
 *   mailbox, so callers compare it with the account's current address before treating the
 *   address as verified.
 */

export type OneTimeTokenPurpose = 'verify_email' | 'reset_password';

export const ONE_TIME_TOKEN_LIFETIME_MS: Readonly<Record<OneTimeTokenPurpose, number>> = {
  verify_email: ONE_TIME_TOKEN.verifyEmailMs,
  reset_password: ONE_TIME_TOKEN.resetPasswordMs,
};

/** Shape of an issued token: 32 random bytes, base64url. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface IssuedOneTimeToken {
  /** The raw token. Goes into one email and nowhere else; never stored or logged. */
  readonly token: string;
  readonly expiresAt: Date;
}

export interface ConsumedOneTimeToken {
  readonly userId: string;
  readonly sentTo: string;
}

/** A database handle or an open transaction. */
type Executor = DbClient | DbTransaction;

export function hashOneTimeToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export class OneTimeTokenStore {
  readonly #db: DbClient;
  readonly #now: () => Date;

  constructor(options: { db: DbClient; now: () => Date }) {
    this.#db = options.db;
    this.#now = options.now;
  }

  /**
   * Create the user's one valid token for a purpose. Older unused tokens of the same purpose,
   * and the user's expired tokens of any purpose, are deleted in the same transaction.
   */
  async issue(
    userId: string,
    purpose: OneTimeTokenPurpose,
    sentTo: string,
  ): Promise<IssuedOneTimeToken> {
    const now = this.#now();
    const token = randomBytes(ONE_TIME_TOKEN.bytes).toString('base64url');
    const expiresAt = new Date(now.getTime() + ONE_TIME_TOKEN_LIFETIME_MS[purpose]);
    await this.#db.$transaction([
      this.#db.oneTimeToken.deleteMany({
        where: { userId, OR: [{ purpose, usedAt: null }, { expiresAt: { lte: now } }] },
      }),
      this.#db.oneTimeToken.create({
        data: { userId, purpose, tokenHash: hashOneTimeToken(token), sentTo, expiresAt },
      }),
    ]);
    return { token, expiresAt };
  }

  /**
   * Use a token. Returns whose it was, or `null` for every other case (unknown, malformed, wrong
   * purpose, expired, already used); callers must not tell those apart to the client.
   *
   * Atomic: one `UPDATE … WHERE used_at IS NULL` claims the row, so of any number of concurrent
   * requests with the same token exactly one succeeds. Pass the caller's transaction as
   * `executor` so the claim is rolled back if what the token authorises then fails.
   */
  async consume(
    presented: string,
    purpose: OneTimeTokenPurpose,
    executor: Executor = this.#db,
  ): Promise<ConsumedOneTimeToken | null> {
    // Hash whatever was presented, so a malformed token costs the same as a wrong one.
    const tokenHash = hashOneTimeToken(presented);
    if (!TOKEN_PATTERN.test(presented)) return null;
    const now = this.#now();
    const claimed = await executor.oneTimeToken.updateManyAndReturn({
      where: { tokenHash, purpose, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
      select: { userId: true, sentTo: true },
    });
    return claimed[0] ?? null;
  }

  /** Delete a user's tokens (all purposes, or one): outstanding links stop working. */
  async revokeForUser(
    userId: string,
    purpose?: OneTimeTokenPurpose,
    executor: Executor = this.#db,
  ): Promise<void> {
    await executor.oneTimeToken.deleteMany({
      where: { userId, ...(purpose === undefined ? {} : { purpose }) },
    });
  }
}
