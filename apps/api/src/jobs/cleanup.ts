import type { DbClient } from '../db/index.js';

/** How long past their deadline expired rows are kept (so a clock skew never deletes a live one). */
export const CLEANUP_GRACE_MS = 24 * 60 * 60 * 1000;

export interface CleanupSummary {
  readonly refreshTokens: number;
  readonly oneTimeTokens: number;
}

/**
 * Daily cleanup of expired authentication data (doc 06 §6: "expired tokens purged daily").
 *
 * - A refresh token is deleted only when its WHOLE login session has expired (the absolute
 *   30-day deadline). Until then even a revoked token stays: presenting it again is how theft is
 *   detected, and that needs the row.
 * - A one-time token (email verification, password reset) goes a day after it expired or was used.
 *
 * Idempotent and safe to run concurrently with requests. The scheduler (T23) calls it.
 */
export async function purgeExpiredAuthData(
  db: DbClient,
  now: Date = new Date(),
): Promise<CleanupSummary> {
  const cutoff = new Date(now.getTime() - CLEANUP_GRACE_MS);
  const refresh = await db.refreshToken.deleteMany({ where: { familyExpiresAt: { lt: cutoff } } });
  const oneTime = await db.oneTimeToken.deleteMany({
    where: { OR: [{ expiresAt: { lt: cutoff } }, { usedAt: { lt: cutoff } }] },
  });
  return { refreshTokens: refresh.count, oneTimeTokens: oneTime.count };
}
