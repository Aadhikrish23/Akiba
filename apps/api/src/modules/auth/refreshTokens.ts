import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { refreshTokenSchema } from '@akiba/shared';
import type { DbClient, DbTransaction } from '../../db/index.js';

/**
 * Refresh tokens (doc 09 S-AUTH-6).
 *
 * - A token is 32 bytes from the OS CSPRNG, base64url. Only its SHA-256 is stored: the token has
 *   256 bits of entropy, so a fast hash is enough (there is nothing to brute-force) and lookups
 *   can use the unique index on the hash.
 * - Every login starts a FAMILY (`family_id`), which is also the session ID (`sid`) inside access
 *   tokens. Using a token revokes it and issues its successor in the same family.
 * - Presenting a token that was already revoked means two parties hold the same token (theft or
 *   replay), so the whole family is revoked: the session ends for both.
 */

export interface IssuedRefreshToken {
  /** The raw token. Returned to the client once; never stored or logged. */
  readonly token: string;
  readonly familyId: string;
  /** Idle deadline of this token. */
  readonly expiresAt: Date;
}

export type RotationResult =
  | {
      readonly outcome: 'rotated';
      readonly userId: string;
      readonly refresh: IssuedRefreshToken;
    }
  /** Unknown, malformed, expired, or belonging to a deleted user. */
  | { readonly outcome: 'invalid' }
  /** An already-revoked token was presented; its family has been revoked. */
  | { readonly outcome: 'reuse_detected'; readonly userId: string; readonly familyId: string };

export interface RefreshTokenLifetimes {
  readonly idleMs: number;
  readonly absoluteMs: number;
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

const truncate = (value: string | undefined, max: number): string | null =>
  value === undefined || value === '' ? null : value.slice(0, max);

export class RefreshTokenStore {
  readonly #db: DbClient;
  readonly #lifetimes: RefreshTokenLifetimes;
  readonly #now: () => Date;

  constructor(options: { db: DbClient; lifetimes: RefreshTokenLifetimes; now: () => Date }) {
    this.#db = options.db;
    this.#lifetimes = options.lifetimes;
    this.#now = options.now;
  }

  /** Start a new family (a new session) for a user who has just authenticated. */
  async startFamily(userId: string, userAgent: string | undefined): Promise<IssuedRefreshToken> {
    const now = this.#now();
    const token = randomBytes(32).toString('base64url');
    const familyId = randomUUID();
    const familyExpiresAt = new Date(now.getTime() + this.#lifetimes.absoluteMs);
    const expiresAt = this.#idleDeadline(now, familyExpiresAt);
    await this.#db.refreshToken.create({
      data: {
        userId,
        familyId,
        tokenHash: hashRefreshToken(token),
        expiresAt,
        familyExpiresAt,
        userAgent: truncate(userAgent, 255),
        createdAt: now,
      },
    });
    return { token, familyId, expiresAt };
  }

  /**
   * Exchange a refresh token for its successor.
   *
   * Atomicity: the first statement revokes the presented token only if it is still live
   * (`UPDATE … WHERE revoked_at IS NULL`). PostgreSQL row-locks the row, so of any number of
   * concurrent requests with the same token exactly one gets it; the others see zero rows
   * updated, find the token revoked and take the reuse path. Everything runs in one transaction,
   * which is committed in every outcome so that revocations are never rolled back.
   */
  async rotate(presented: string, userAgent: string | undefined): Promise<RotationResult> {
    // Anything that is not shaped like one of our tokens cannot be in the table.
    if (!refreshTokenSchema.safeParse(presented).success) return { outcome: 'invalid' };
    const tokenHash = hashRefreshToken(presented);
    const now = this.#now();

    return this.#db.$transaction(async (tx): Promise<RotationResult> => {
      const claimed = await tx.refreshToken.updateManyAndReturn({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: now },
        select: { id: true, userId: true, familyId: true, expiresAt: true, familyExpiresAt: true },
      });
      const current = claimed[0];

      if (current === undefined) {
        const known = await tx.refreshToken.findUnique({
          where: { tokenHash },
          select: { userId: true, familyId: true },
        });
        if (known === null) return { outcome: 'invalid' };
        await tx.refreshToken.updateMany({
          where: { familyId: known.familyId, revokedAt: null },
          data: { revokedAt: now },
        });
        return { outcome: 'reuse_detected', userId: known.userId, familyId: known.familyId };
      }

      // From here on the presented token is revoked, whatever happens next.
      if (current.expiresAt <= now || current.familyExpiresAt <= now) return { outcome: 'invalid' };
      const user = await tx.user.findUnique({
        where: { id: current.userId },
        select: { deletedAt: true },
      });
      if (user === null || user.deletedAt !== null) return { outcome: 'invalid' };

      const token = randomBytes(32).toString('base64url');
      const expiresAt = this.#idleDeadline(now, current.familyExpiresAt);
      const successor = await tx.refreshToken.create({
        data: {
          userId: current.userId,
          familyId: current.familyId,
          tokenHash: hashRefreshToken(token),
          expiresAt,
          familyExpiresAt: current.familyExpiresAt,
          userAgent: truncate(userAgent, 255),
          createdAt: now,
        },
        select: { id: true },
      });
      await tx.refreshToken.update({
        where: { id: current.id },
        data: { replacedById: successor.id },
      });
      return {
        outcome: 'rotated',
        userId: current.userId,
        refresh: { token, familyId: current.familyId, expiresAt },
      };
    });
  }

  /**
   * Revoke the family a token belongs to (logout). Works for a token that is already revoked or
   * expired, and does nothing for an unknown one, so logout is idempotent.
   */
  async revokeFamilyOf(presented: string): Promise<void> {
    if (!refreshTokenSchema.safeParse(presented).success) return;
    const known = await this.#db.refreshToken.findUnique({
      where: { tokenHash: hashRefreshToken(presented) },
      select: { familyId: true },
    });
    if (known === null) return;
    await this.#db.refreshToken.updateMany({
      where: { familyId: known.familyId, revokedAt: null },
      data: { revokedAt: this.#now() },
    });
  }

  /**
   * Revoke every family of one user (logout everywhere). The user ID comes from a verified
   * token or a consumed one-time token, never from input. `executor` lets a caller do it inside
   * its own transaction (password reset); `exceptFamilyId` keeps one session alive (the one that
   * just changed the password).
   */
  async revokeAllForUser(
    userId: string,
    options: { executor?: DbClient | DbTransaction; exceptFamilyId?: string } = {},
  ): Promise<void> {
    await (options.executor ?? this.#db).refreshToken.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(options.exceptFamilyId === undefined
          ? {}
          : { familyId: { not: options.exceptFamilyId } }),
      },
      data: { revokedAt: this.#now() },
    });
  }

  /**
   * Is the session (family) of an access token still alive? True while the family has a token
   * that is neither revoked nor expired and the user is not deleted. The family must belong to
   * `userId`: a session ID alone never authorises anything.
   */
  async isSessionActive(userId: string, familyId: string): Promise<boolean> {
    const now = this.#now();
    const live = await this.#db.refreshToken.findFirst({
      where: {
        familyId,
        userId,
        revokedAt: null,
        expiresAt: { gt: now },
        familyExpiresAt: { gt: now },
        user: { deletedAt: null },
      },
      select: { id: true },
    });
    return live !== null;
  }

  #idleDeadline(now: Date, familyExpiresAt: Date): Date {
    return new Date(Math.min(now.getTime() + this.#lifetimes.idleMs, familyExpiresAt.getTime()));
  }
}
