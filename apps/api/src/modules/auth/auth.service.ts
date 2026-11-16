import { createHash } from 'node:crypto';
import type {
  AuthUser,
  ChangePasswordRequest,
  LoginRequest,
  RegisterRequest,
  ResetPasswordRequest,
} from '@akiba/shared';
import { EMAIL_BUDGET } from '../../config/constants.js';
import { Prisma, type DbClient } from '../../db/index.js';
import type { BackgroundTasks } from '../../lib/backgroundTasks.js';
import {
  invalidCredentials,
  invalidOneTimeToken,
  invalidRefreshToken,
  rateLimited,
  reauthenticationFailed,
  unauthenticated,
  validationFailed,
} from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import type { AuthContext } from '../../middleware/auth.js';
import type { RateLimitStore } from '../../middleware/rateLimit.js';
import type { EmailKind, EmailMessage, EmailSender, EmailTemplates } from '../email/index.js';
import type { AccessTokenService, IssuedAccessToken } from './accessTokens.js';
import type { BreachedPasswordChecker } from './breachedPasswords.js';
import type { LoginThrottle } from './loginThrottle.js';
import type { OneTimeTokenStore } from './oneTimeTokens.js';
import { normalisePassword, type PasswordHasher } from './password.js';
import type { IssuedRefreshToken, RefreshTokenStore } from './refreshTokens.js';

export interface ClientInfo {
  readonly userAgent: string | undefined;
}

export interface Session {
  readonly access: IssuedAccessToken;
  readonly refresh: IssuedRefreshToken;
}

/**
 * The auth module's public face (doc 09 S-AUTH-12). HTTP routes and the auth middleware depend
 * on this interface only, so a managed identity provider could replace the implementation.
 */
export interface AuthService {
  /** Resolves the same way whether or not the email already had an account. */
  register(input: RegisterRequest): Promise<void>;
  login(input: LoginRequest, client: ClientInfo): Promise<Session & { user: AuthUser }>;
  refresh(refreshToken: string | undefined, client: ClientInfo): Promise<Session>;
  /** Ends the session the refresh token belongs to. Never fails for a bad or missing token. */
  logout(refreshToken: string | undefined): Promise<void>;
  /** Ends every session of the user. */
  logoutAll(userId: string): Promise<void>;
  /** Resolve an access token to its user and live session, or `null`. */
  authenticate(accessToken: string): Promise<AuthContext | null>;
  getUser(userId: string): Promise<AuthUser | null>;

  /**
   * Use a verification link (FR-AUTH-006). Throws the one generic invalid-token error for every
   * failure.
   */
  verifyEmail(token: string): Promise<void>;
  /**
   * Send the caller a new verification link, if their address still needs one. Returns at once;
   * the work runs in the background and its outcome is never reported.
   */
  resendVerification(userId: string): void;
  /**
   * Start a password reset for an address (FR-AUTH-005). Returns at once and reports nothing:
   * the lookup, the token and the email all happen in the background, after the response, so
   * neither the answer nor its timing depends on whether the address has an account.
   */
  requestPasswordReset(email: string): void;
  /**
   * Set a new password with a reset link. Ends every session of the user (S-AUTH-10). Throws a
   * validation error for a refused password (the link stays usable) and the generic
   * invalid-token error otherwise.
   */
  resetPassword(input: ResetPasswordRequest): Promise<void>;
  /**
   * Change the password of the signed-in caller, who must present the current one (S-AUTH-11).
   * Ends every OTHER session of the user.
   */
  changePassword(auth: AuthContext, input: ChangePasswordRequest): Promise<void>;
}

export interface AuthServiceDependencies {
  readonly db: DbClient;
  readonly hasher: PasswordHasher;
  /**
   * A valid hash of a password nobody knows, made with `hasher` before the service starts
   * (see `createDummyHash`). Login verifies against it when there is no usable account.
   */
  readonly dummyHash: string;
  readonly breachedPasswords: BreachedPasswordChecker;
  readonly accessTokens: AccessTokenService;
  readonly refreshTokens: RefreshTokenStore;
  readonly loginThrottle: LoginThrottle;
  readonly oneTimeTokens: OneTimeTokenStore;
  readonly emailSender: EmailSender;
  readonly emailTemplates: EmailTemplates;
  /** Runs email delivery (and all of forgot-password) after the response. */
  readonly background: BackgroundTasks;
  /** Counters for the per-address email budget ({@link EMAIL_BUDGET}). */
  readonly emailBudgetStore: RateLimitStore;
  readonly logger: Logger;
  readonly now: () => Date;
}

const USER_FIELDS = { id: true, email: true, displayName: true, emailVerifiedAt: true } as const;

function toAuthUser(user: {
  id: string;
  email: string;
  displayName: string | null;
  emailVerifiedAt: Date | null;
}): AuthUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    emailVerified: user.emailVerifiedAt !== null,
  };
}

/** `user.email` is citext, so uniqueness ignores case; the throttle key must do the same. */
const throttleKey = (email: string): string => email.toLowerCase();

/** Same mailbox? Mirrors the case-insensitive comparison of the citext columns. */
const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

const BREACHED_MESSAGE = 'is too common or has appeared in a data breach; choose a different one';

export function createAuthService(dependencies: AuthServiceDependencies): AuthService {
  const {
    db,
    hasher,
    dummyHash,
    breachedPasswords,
    accessTokens,
    refreshTokens,
    loginThrottle,
    oneTimeTokens,
    emailSender,
    emailTemplates,
    background,
    emailBudgetStore,
    now,
  } = dependencies;
  const log = dependencies.logger.child({ module: 'auth' });

  /** Refuse a new password that attackers already know (S-AUTH-2). `path` names the field. */
  async function assertNotBreached(password: string, path: string): Promise<void> {
    if (await breachedPasswords.isBreached(password)) {
      throw validationFailed([{ path, message: BREACHED_MESSAGE }]);
    }
  }

  /**
   * May another email of this kind go to this address now? Counted per address and kind, keyed
   * by a hash so the store never holds addresses. Only ever called for addresses that have an
   * account, from background work, so the count is invisible to the requester.
   */
  async function withinEmailBudget(kind: EmailKind, address: string): Promise<boolean> {
    const key = createHash('sha256').update(address.toLowerCase(), 'utf8').digest('hex');
    const hit = await emailBudgetStore.hit(
      `email:${kind}:${key}`,
      EMAIL_BUDGET.windowMs,
      now().getTime(),
    );
    if (hit.count > EMAIL_BUDGET.max) {
      log.info({ event: 'email_suppressed', kind }, 'email not sent: per-address budget used up');
      return false;
    }
    return true;
  }

  /** Hand a message to the sender after the response; a delivery failure is logged, not thrown. */
  function sendLater(message: EmailMessage): void {
    background.run(`email:${message.kind}`, () => emailSender.send(message));
  }

  /** Issue a verification link for the user's current address and email it. */
  async function sendVerification(user: {
    id: string;
    email: string;
    displayName: string | null;
  }): Promise<void> {
    if (!(await withinEmailBudget('verify_email', user.email))) return;
    const issued = await oneTimeTokens.issue(user.id, 'verify_email', user.email);
    await emailSender.send(emailTemplates.verifyEmail(user, issued.token));
  }

  return {
    async register(input) {
      await assertNotBreached(input.password, 'password');
      // Hash first, unconditionally: both outcomes below then cost one hash, and the response
      // gives no sign of which one happened (no user enumeration). Both outcomes also lead to
      // exactly one email, sent after the response.
      const passwordHash = await hasher.hash(input.password);
      try {
        const user = await db.user.create({
          data: { email: input.email, passwordHash, displayName: input.displayName },
          select: { id: true, email: true, displayName: true },
        });
        log.info({ event: 'register', userId: user.id }, 'account created');
        background.run('register:verification', () => sendVerification(user));
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          // The address already has an account. Nothing is changed and the caller is not told.
          // The owner of the address is: with a notice that carries no token and does not
          // confirm anything, so whoever registered gains nothing from it.
          log.info({ event: 'register_existing' }, 'registration for an existing address ignored');
          background.run('register:existing', async () => {
            const existing = await db.user.findUnique({
              where: { email: input.email },
              select: { email: true, displayName: true, deletedAt: true },
            });
            if (existing === null || existing.deletedAt !== null) return;
            if (!(await withinEmailBudget('registration_attempt', existing.email))) return;
            await emailSender.send(emailTemplates.registrationAttempt(existing));
          });
          return;
        }
        throw error;
      }
    },

    async login(input, client) {
      const key = throttleKey(input.email);
      const decision = await loginThrottle.attempt(key, now().getTime());
      if (!decision.allowed) {
        log.info({ event: 'login_throttled' }, 'login refused by per-account backoff');
        throw rateLimited(Math.max(1, Math.ceil(decision.retryAfterMs / 1000)));
      }

      const user = await db.user.findUnique({
        where: { email: input.email },
        select: { ...USER_FIELDS, passwordHash: true, deletedAt: true },
      });
      // Always exactly one argon2 verification, against the dummy hash when there is no usable
      // account (unknown email, OAuth-only account, account in deletion), so the work done does
      // not depend on whether the email exists (S-AUTH-3).
      const usable = user !== null && user.passwordHash !== null && user.deletedAt === null;
      const storedHash = usable && user.passwordHash !== null ? user.passwordHash : dummyHash;
      const passwordMatches = await hasher.verify(storedHash, input.password);
      if (!usable || !passwordMatches) {
        log.info({ event: 'login_failed' }, 'login failed');
        throw invalidCredentials();
      }

      await loginThrottle.succeed(key);
      const refresh = await refreshTokens.startFamily(user.id, client.userAgent);
      const access = await accessTokens.issue({ userId: user.id, sessionId: refresh.familyId });
      log.info({ event: 'login', userId: user.id, sessionId: refresh.familyId }, 'login succeeded');
      return { user: toAuthUser(user), access, refresh };
    },

    async refresh(refreshToken, client) {
      if (refreshToken === undefined) throw invalidRefreshToken();
      const result = await refreshTokens.rotate(refreshToken, client.userAgent);
      if (result.outcome === 'reuse_detected') {
        log.warn(
          { event: 'refresh_reuse', userId: result.userId, sessionId: result.familyId },
          'revoked refresh token presented; session revoked',
        );
        throw invalidRefreshToken();
      }
      if (result.outcome === 'invalid') throw invalidRefreshToken();
      const access = await accessTokens.issue({
        userId: result.userId,
        sessionId: result.refresh.familyId,
      });
      return { access, refresh: result.refresh };
    },

    async logout(refreshToken) {
      if (refreshToken === undefined) return;
      await refreshTokens.revokeFamilyOf(refreshToken);
    },

    async logoutAll(userId) {
      await refreshTokens.revokeAllForUser(userId);
      log.info({ event: 'logout_all', userId }, 'all sessions revoked');
    },

    async authenticate(accessToken) {
      const claims = await accessTokens.verify(accessToken);
      if (claims === null) return null;
      // Database lookup on every request: revocation takes effect immediately (see the report
      // for the trade-off against caching).
      const active = await refreshTokens.isSessionActive(claims.userId, claims.sessionId);
      return active ? claims : null;
    },

    async getUser(userId) {
      const user = await db.user.findFirst({
        where: { id: userId, deletedAt: null },
        select: USER_FIELDS,
      });
      return user === null ? null : toAuthUser(user);
    },

    async verifyEmail(token) {
      const at = now();
      const verifiedUserId = await db.$transaction(async (tx) => {
        const claim = await oneTimeTokens.consume(token, 'verify_email', tx);
        if (claim === null) return null;
        const user = await tx.user.findFirst({
          where: { id: claim.userId, deletedAt: null },
          select: { id: true, email: true, emailVerifiedAt: true },
        });
        // The link proves control of the mailbox it was sent to. If the account has another
        // address by now, it proves nothing about that one.
        if (user === null || !sameAddress(user.email, claim.sentTo)) return null;
        if (user.emailVerifiedAt === null) {
          await tx.user.update({ where: { id: user.id }, data: { emailVerifiedAt: at } });
        }
        return user.id;
      });
      if (verifiedUserId === null) {
        log.info({ event: 'verify_email_failed' }, 'email verification refused');
        throw invalidOneTimeToken();
      }
      log.info({ event: 'verify_email', userId: verifiedUserId }, 'email verified');
    },

    resendVerification(userId) {
      background.run('resend-verification', async () => {
        const user = await db.user.findFirst({
          where: { id: userId, deletedAt: null },
          select: { id: true, email: true, displayName: true, emailVerifiedAt: true },
        });
        if (user === null || user.emailVerifiedAt !== null) return;
        await sendVerification(user);
      });
    },

    requestPasswordReset(email) {
      background.run('password-reset-request', async () => {
        const user = await db.user.findUnique({
          where: { email },
          select: { id: true, email: true, displayName: true, deletedAt: true },
        });
        if (user === null || user.deletedAt !== null) {
          log.info(
            { event: 'password_reset_request', outcome: 'ignored' },
            'reset request ignored',
          );
          return;
        }
        if (!(await withinEmailBudget('reset_password', user.email))) return;
        const issued = await oneTimeTokens.issue(user.id, 'reset_password', user.email);
        log.info(
          { event: 'password_reset_request', outcome: 'sent', userId: user.id },
          'reset link issued',
        );
        await emailSender.send(emailTemplates.resetPassword(user, issued.token));
      });
    },

    async resetPassword(input) {
      // Policy first: a refused password must not burn the link.
      await assertNotBreached(input.newPassword, 'newPassword');
      // Hash before looking at the token, so a wrong token costs the same as a right one.
      const passwordHash = await hasher.hash(input.newPassword);
      const at = now();

      const user = await db.$transaction(async (tx) => {
        const claim = await oneTimeTokens.consume(input.token, 'reset_password', tx);
        if (claim === null) return null;
        const account = await tx.user.findFirst({
          where: { id: claim.userId, deletedAt: null },
          select: { id: true, email: true, displayName: true, emailVerifiedAt: true },
        });
        if (account === null) return null;
        // Using the link proves control of the mailbox it was sent to, which is exactly what
        // email verification establishes; so an unverified address becomes verified, but only
        // if the account still has the address the link went to.
        const verifies =
          account.emailVerifiedAt === null && sameAddress(account.email, claim.sentTo);
        await tx.user.update({
          where: { id: account.id },
          data: { passwordHash, ...(verifies ? { emailVerifiedAt: at } : {}) },
        });
        // S-AUTH-10: every session ends, in the same transaction as the new password.
        await refreshTokens.revokeAllForUser(account.id, { executor: tx });
        // No other emailed link survives a reset (this also removes the token just used).
        await oneTimeTokens.revokeForUser(account.id, undefined, tx);
        return { ...account, verifiedNow: verifies };
      });

      if (user === null) {
        log.info({ event: 'password_reset_failed' }, 'password reset refused');
        throw invalidOneTimeToken();
      }
      // The owner has proved who they are; failed guesses by someone else no longer count.
      await loginThrottle.succeed(throttleKey(user.email));
      log.info(
        { event: 'password_reset', userId: user.id, emailVerified: user.verifiedNow },
        'password reset; all sessions revoked',
      );
      sendLater(emailTemplates.passwordChanged(user));
    },

    async changePassword(auth, input) {
      const user = await db.user.findFirst({
        where: { id: auth.userId, deletedAt: null },
        select: { id: true, email: true, displayName: true, passwordHash: true },
      });
      if (user === null) throw unauthenticated();

      // Guessing the current password here counts against the same backoff as guessing it at
      // login, so a stolen access token does not open an unthrottled oracle (S-AUTH-4).
      const key = throttleKey(user.email);
      const decision = await loginThrottle.attempt(key, now().getTime());
      if (!decision.allowed) {
        log.info(
          { event: 'password_change_throttled', userId: user.id },
          'password change throttled',
        );
        throw rateLimited(Math.max(1, Math.ceil(decision.retryAfterMs / 1000)));
      }
      // One verification in every case; an account without a password (OAuth-only) fails it.
      const matches = await hasher.verify(user.passwordHash ?? dummyHash, input.currentPassword);
      if (user.passwordHash === null || !matches) {
        log.info({ event: 'password_change_failed', userId: user.id }, 'current password wrong');
        throw reauthenticationFailed();
      }
      await loginThrottle.succeed(key);

      if (normalisePassword(input.newPassword) === normalisePassword(input.currentPassword)) {
        throw validationFailed([
          { path: 'newPassword', message: 'must be different from the current password' },
        ]);
      }
      await assertNotBreached(input.newPassword, 'newPassword');
      const passwordHash = await hasher.hash(input.newPassword);

      await db.$transaction(async (tx) => {
        await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
        // Everyone else who holds a session is signed out; the caller stays signed in.
        await refreshTokens.revokeAllForUser(user.id, {
          executor: tx,
          exceptFamilyId: auth.sessionId,
        });
        // A reset link requested before the change must not undo it.
        await oneTimeTokens.revokeForUser(user.id, 'reset_password', tx);
      });
      log.info(
        { event: 'password_change', userId: user.id },
        'password changed; other sessions revoked',
      );
      sendLater(emailTemplates.passwordChanged(user));
    },
  };
}
