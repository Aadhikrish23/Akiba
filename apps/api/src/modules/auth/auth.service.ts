import type { AuthUser, LoginRequest, RegisterRequest } from '@akiba/shared';
import { Prisma, type DbClient } from '../../db/index.js';
import {
  invalidCredentials,
  invalidRefreshToken,
  rateLimited,
  validationFailed,
} from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import type { AuthContext } from '../../middleware/auth.js';
import type { AccessTokenService, IssuedAccessToken } from './accessTokens.js';
import type { BreachedPasswordChecker } from './breachedPasswords.js';
import type { LoginThrottle } from './loginThrottle.js';
import { createDummyHash, type PasswordHasher } from './password.js';
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
}

export interface AuthServiceDependencies {
  readonly db: DbClient;
  readonly hasher: PasswordHasher;
  readonly breachedPasswords: BreachedPasswordChecker;
  readonly accessTokens: AccessTokenService;
  readonly refreshTokens: RefreshTokenStore;
  readonly loginThrottle: LoginThrottle;
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

export function createAuthService(dependencies: AuthServiceDependencies): AuthService {
  const { db, hasher, breachedPasswords, accessTokens, refreshTokens, loginThrottle, now } =
    dependencies;
  const log = dependencies.logger.child({ module: 'auth' });

  // Computed once, on first use. A failure is not cached, so the next login retries.
  let dummyHash: Promise<string> | undefined;
  const getDummyHash = (): Promise<string> => {
    dummyHash ??= createDummyHash(hasher).catch((error: unknown) => {
      dummyHash = undefined;
      throw error;
    });
    return dummyHash;
  };

  return {
    async register(input) {
      if (await breachedPasswords.isBreached(input.password)) {
        throw validationFailed([
          {
            path: 'password',
            message: 'is too common or has appeared in a data breach; choose a different one',
          },
        ]);
      }
      // Hash first, unconditionally: both outcomes below then cost one hash, and the response
      // gives no sign of which one happened (no user enumeration).
      const passwordHash = await hasher.hash(input.password);
      try {
        const user = await db.user.create({
          data: { email: input.email, passwordHash, displayName: input.displayName },
          select: { id: true },
        });
        log.info({ event: 'register', userId: user.id }, 'account created');
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          // The address already has an account. Nothing is changed and the caller is not told;
          // T5 sends the owner an email instead.
          log.info({ event: 'register_existing' }, 'registration for an existing address ignored');
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
      const storedHash =
        usable && user.passwordHash !== null ? user.passwordHash : await getDummyHash();
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
  };
}
