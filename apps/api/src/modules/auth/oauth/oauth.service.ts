import type {
  AuthUser,
  OAuthLinkRequest,
  OAuthProvider,
  OAuthSignInRequest,
  OAuthStartRequest,
  OAuthStartResponse,
  SignInMethodsResponse,
} from '@akiba/shared';
import { WEB_OAUTH_CALLBACK_PATH, type OAuthConfig } from '../../../config/env.js';
import { Prisma, type DbClient } from '../../../db/index.js';
import type { BackgroundTasks } from '../../../lib/backgroundTasks.js';
import {
  accountEmailUnverified,
  emailNotVerified,
  invalidOAuthState,
  lastSignInMethod,
  notFound,
  oauthEmailNotVerified,
  oauthIdentityInUse,
  oauthProviderAlreadyLinked,
  oauthProviderNotConfigured,
  oauthProviderUnavailable,
  oauthSignInFailed,
  rateLimited,
  reauthenticationFailed,
  reauthenticationRequired,
  unauthenticated,
  validationFailed,
} from '../../../lib/errors.js';
import type { Logger } from '../../../lib/logger.js';
import type { AuthContext } from '../../../middleware/auth.js';
import type { EmailSender, EmailTemplates } from '../../email/index.js';
import type { AccessTokenService } from '../accessTokens.js';
import type { ClientInfo, Session } from '../auth.service.js';
import type { LoginThrottle } from '../loginThrottle.js';
import type { PasswordHasher } from '../password.js';
import type { RefreshTokenStore } from '../refreshTokens.js';
import { OAuthCodeExchangeError, type OAuthCodeExchanger } from './codeExchanger.js';
import { OidcVerificationError, type OidcIdentity, type OidcVerifier } from './oidcVerifier.js';
import { PROVIDER_PROFILES } from './providers.js';
import { OAUTH_STATE_LIFETIME_MS, type OAuthStateStore } from './stateStore.js';

/**
 * How recently an account WITHOUT a password must have signed in to link a provider. Such an
 * account cannot confirm a password, so "sign in again" is its re-authentication (S-AUTH-11).
 */
export const LINK_RECENT_SIGN_IN_MS = 10 * 60 * 1000;

/** `{idToken, nonce}` or `{code, codeVerifier, redirectUri, state}`. */
export type OAuthCredential = OAuthSignInRequest;

/** What Apple posts to the callback relay (only the fields that are passed on). */
export interface AppleCallbackForm {
  readonly code?: string | undefined;
  readonly state?: string | undefined;
  readonly error?: string | undefined;
}

/**
 * Sign-in with Google and Apple, and linking them to accounts (FR-AUTH-002, FR-AUTH-007; doc 09
 * S-AUTH-9). Routes depend on this interface only (S-AUTH-12).
 */
export interface OAuthService {
  /** Begin the web flow: remember `state`/`nonce`/PKCE challenge and build the provider URL. */
  start(provider: OAuthProvider, input: OAuthStartRequest): Promise<OAuthStartResponse>;
  /** Sign in with a provider, creating or linking an account as the rules in this file allow. */
  signIn(
    provider: OAuthProvider,
    credential: OAuthCredential,
    client: ClientInfo,
  ): Promise<Session & { user: AuthUser }>;
  /** Add a provider identity to the signed-in caller's account. */
  link(auth: AuthContext, input: OAuthLinkRequest): Promise<SignInMethodsResponse>;
  /** Remove a provider from the caller's account, unless it is the last way in. */
  unlink(auth: AuthContext, provider: OAuthProvider): Promise<SignInMethodsResponse>;
  methods(userId: string): Promise<SignInMethodsResponse>;
  /** Where to send the browser after Apple posted to the callback relay. */
  appleCallbackRedirect(form: AppleCallbackForm): string;
}

export interface OAuthServiceDependencies {
  readonly db: DbClient;
  readonly config: OAuthConfig;
  /** Origin of the web app; the Apple relay redirects there. */
  readonly webBaseUrl: string;
  readonly verifier: OidcVerifier;
  readonly exchanger: OAuthCodeExchanger;
  readonly states: OAuthStateStore;
  readonly accessTokens: AccessTokenService;
  readonly refreshTokens: RefreshTokenStore;
  /** Re-authentication with the current password, under the same backoff as login. */
  readonly hasher: PasswordHasher;
  readonly dummyHash: string;
  readonly loginThrottle: LoginThrottle;
  readonly emailSender: EmailSender;
  readonly emailTemplates: EmailTemplates;
  readonly background: BackgroundTasks;
  readonly logger: Logger;
  readonly now: () => Date;
}

const USER_FIELDS = {
  id: true,
  email: true,
  displayName: true,
  emailVerifiedAt: true,
  deletedAt: true,
} as const;

interface UserRow {
  id: string;
  email: string;
  displayName: string | null;
  emailVerifiedAt: Date | null;
  deletedAt: Date | null;
}

const toAuthUser = (user: UserRow): AuthUser => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName,
  emailVerified: user.emailVerifiedAt !== null,
});

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

/** PostgreSQL could not serialise two transactions (SQLSTATE 40001); the loser may be retried. */
const isSerializationFailure = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';

const PROVIDER_ERROR = /^[a-z_]{1,64}$/;
const CALLBACK_CODE = /^[\x21-\x7e]{1,2048}$/;
const CALLBACK_STATE = /^[A-Za-z0-9_-]{1,128}$/;

export function createOAuthService(dependencies: OAuthServiceDependencies): OAuthService {
  const {
    db,
    config,
    verifier,
    exchanger,
    states,
    accessTokens,
    refreshTokens,
    hasher,
    dummyHash,
    loginThrottle,
    emailSender,
    emailTemplates,
    background,
    now,
  } = dependencies;
  const log = dependencies.logger.child({ module: 'auth', part: 'oauth' });

  const clientIds = (provider: OAuthProvider): readonly string[] => config[provider].clientIds;

  /** The client of the authorization-code flow, if the provider is set up for it. */
  function webClientId(provider: OAuthProvider): string | undefined {
    const secretPresent =
      provider === 'google'
        ? config.google.clientSecret !== undefined
        : config.apple.webKey !== undefined;
    return secretPresent ? clientIds(provider)[0] : undefined;
  }

  /**
   * Turn what the client presented into an identity the provider vouches for. Everything that
   * can be refused without the provider is refused first; nothing is written here except the
   * use of a `state`.
   */
  async function identify(
    provider: OAuthProvider,
    credential: OAuthCredential,
  ): Promise<OidcIdentity> {
    if (clientIds(provider).length === 0) throw oauthProviderNotConfigured('sign-in');

    try {
      if ('idToken' in credential) {
        return await verifier.verify(provider, credential.idToken, {
          audiences: clientIds(provider),
          nonce: credential.nonce,
          allowHashedNonce: true,
        });
      }

      const clientId = webClientId(provider);
      if (clientId === undefined) throw oauthProviderNotConfigured('web flow');
      // `state` first: it is checked and used up before anything is sent to the provider.
      const started = await states.consume(credential.state, {
        provider,
        redirectUri: credential.redirectUri,
        codeVerifier: credential.codeVerifier,
      });
      if (started === null) {
        log.info({ event: 'oauth_state_refused', provider }, 'oauth state refused');
        throw invalidOAuthState();
      }
      const { idToken } = await exchanger.exchange(provider, {
        code: credential.code,
        codeVerifier: credential.codeVerifier,
        redirectUri: credential.redirectUri,
      });
      // The token came straight from the provider over TLS, and is verified all the same. Its
      // audience must be exactly the web client, its nonce exactly the one stored at start.
      return await verifier.verify(provider, idToken, {
        audiences: [clientId],
        nonce: started.nonce,
        allowHashedNonce: false,
      });
    } catch (error) {
      if (error instanceof OidcVerificationError) {
        if (error.reason === 'unavailable') {
          log.warn({ event: 'oauth_keys_unavailable', provider }, 'provider keys unavailable');
          throw oauthProviderUnavailable(error);
        }
        log.info(
          { event: 'oauth_token_refused', provider, reason: error.detail },
          'id token refused',
        );
        throw oauthSignInFailed();
      }
      if (error instanceof OAuthCodeExchangeError) {
        if (error.reason === 'unavailable') {
          log.error(
            { event: 'oauth_exchange_failed', provider, reason: error.detail },
            'code exchange failed',
          );
          throw oauthProviderUnavailable(error);
        }
        log.info({ event: 'oauth_code_refused', provider }, 'authorization code refused');
        throw oauthSignInFailed();
      }
      throw error;
    }
  }

  function notify(
    user: { email: string; displayName: string | null },
    provider: OAuthProvider,
    action: 'linked' | 'unlinked',
  ): void {
    const message = emailTemplates.signInMethodChanged(user, { provider, action });
    background.run(`email:${message.kind}`, () => emailSender.send(message));
  }

  /**
   * Find or make the account for a verified identity. The order is the whole policy:
   *
   * 1. The identity `(provider, sub)` is already linked → that account, whatever email the token
   *    carries today (Apple may send none after the first time; an address that changed at the
   *    provider never moves the identity to another account).
   * 2. Otherwise the provider must assert a verified email, or nothing happens at all.
   * 3. An account with that address exists:
   *    - its address is verified → link the identity to it and sign in;
   *    - its address is NOT verified → refuse. No link, no sign-in, no change (see the report:
   *      whoever registered it may not be the person the provider vouches for, in either
   *      direction).
   * 4. No account → create one: verified address, no password.
   */
  async function resolveAccount(identity: OidcIdentity): Promise<{
    user: UserRow;
    outcome: 'existing_identity' | 'linked_by_email' | 'created';
  }> {
    const { provider, subject } = identity;
    const linked = await db.oAuthAccount.findUnique({
      where: { provider_providerUserId: { provider, providerUserId: subject } },
      select: { user: { select: USER_FIELDS } },
    });
    if (linked !== null) {
      // Same answer as a password login to an account in deletion.
      if (linked.user.deletedAt !== null) throw oauthSignInFailed();
      return { user: linked.user, outcome: 'existing_identity' };
    }

    if (identity.email === null || !identity.emailVerified) {
      log.info({ event: 'oauth_email_unverified', provider }, 'provider email not verified');
      throw oauthEmailNotVerified();
    }

    const existing = await db.user.findUnique({
      where: { email: identity.email },
      select: USER_FIELDS,
    });
    if (existing !== null) {
      if (existing.deletedAt !== null) throw oauthSignInFailed();
      if (existing.emailVerifiedAt === null) {
        log.info(
          { event: 'oauth_unverified_account_refused', provider, userId: existing.id },
          'sign-in refused: account with this address is unverified',
        );
        throw accountEmailUnverified();
      }
      // The unique (user_id, provider) index refuses a second identity of the same provider.
      await db.oAuthAccount.create({
        data: { userId: existing.id, provider, providerUserId: subject },
      });
      notify(existing, provider, 'linked');
      return { user: existing, outcome: 'linked_by_email' };
    }

    const created = await db.user.create({
      data: {
        email: identity.email,
        emailVerifiedAt: now(),
        displayName: identity.name,
        oauthAccounts: { create: { provider, providerUserId: subject } },
      },
      select: USER_FIELDS,
    });
    return { user: created, outcome: 'created' };
  }

  async function methodsOf(userId: string): Promise<SignInMethodsResponse> {
    const user = await db.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: {
        passwordHash: true,
        oauthAccounts: { select: { provider: true }, orderBy: { provider: 'asc' } },
      },
    });
    if (user === null) throw unauthenticated();
    return {
      hasPassword: user.passwordHash !== null,
      providers: user.oauthAccounts.map((account) => account.provider),
    };
  }

  /**
   * S-AUTH-11 for linking: a stolen access token alone must not be enough to add a sign-in
   * method. With a password: the current password, under the login backoff. Without one: the
   * session must be fresh, i.e. the caller just signed in with a provider.
   */
  async function reauthenticate(
    auth: AuthContext,
    user: { id: string; email: string; passwordHash: string | null },
    currentPassword: string | undefined,
  ): Promise<void> {
    if (user.passwordHash === null) {
      const startedAt = await refreshTokens.sessionStartedAt(user.id, auth.sessionId);
      if (startedAt === null || now().getTime() - startedAt.getTime() > LINK_RECENT_SIGN_IN_MS) {
        throw reauthenticationRequired();
      }
      return;
    }
    if (currentPassword === undefined) {
      throw validationFailed([
        { path: 'currentPassword', message: 'is required for an account with a password' },
      ]);
    }
    const key = user.email.toLowerCase();
    const decision = await loginThrottle.attempt(key, now().getTime());
    if (!decision.allowed) {
      throw rateLimited(Math.max(1, Math.ceil(decision.retryAfterMs / 1000)));
    }
    const matches = await hasher.verify(user.passwordHash, currentPassword);
    if (!matches) {
      log.info({ event: 'oauth_link_reauth_failed', userId: user.id }, 'current password wrong');
      throw reauthenticationFailed();
    }
    await loginThrottle.succeed(key);
  }

  return {
    async start(provider, input) {
      const clientId = webClientId(provider);
      if (clientIds(provider).length === 0) throw oauthProviderNotConfigured('sign-in');
      if (clientId === undefined) throw oauthProviderNotConfigured('web flow');
      if (!config.redirectUris.includes(input.redirectUri)) {
        throw validationFailed([
          { path: 'redirectUri', message: 'is not a redirect URI registered for this server' },
        ]);
      }
      const started = await states.create({
        provider,
        redirectUri: input.redirectUri,
        codeChallenge: input.codeChallenge,
      });
      const profile = PROVIDER_PROFILES[provider];
      const url = new URL(profile.authorizationEndpoint);
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: input.redirectUri,
        scope: profile.scope,
        state: started.state,
        nonce: started.nonce,
        code_challenge: input.codeChallenge,
        code_challenge_method: 'S256',
        ...profile.authorizationParams,
      }).toString();
      log.info({ event: 'oauth_start', provider }, 'oauth sign-in started');
      return {
        authorizationUrl: url.toString(),
        state: started.state,
        expiresIn: OAUTH_STATE_LIFETIME_MS / 1000,
      };
    },

    async signIn(provider, credential, client) {
      const identity = await identify(provider, credential);

      let resolved;
      try {
        resolved = await resolveAccount(identity);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // Lost a race with a concurrent request (same identity or same address), or the account
        // already has another identity of this provider. Look once more; whatever is there now
        // decides. A second conflict can only be the "other identity" case.
        try {
          resolved = await resolveAccount(identity);
        } catch (again) {
          if (isUniqueViolation(again)) throw oauthProviderAlreadyLinked();
          throw again;
        }
      }

      const { user, outcome } = resolved;
      const refresh = await refreshTokens.startFamily(user.id, client.userAgent);
      const access = await accessTokens.issue({ userId: user.id, sessionId: refresh.familyId });
      log.info(
        { event: 'oauth_sign_in', provider, outcome, userId: user.id, sessionId: refresh.familyId },
        'oauth sign-in succeeded',
      );
      return { user: toAuthUser(user), access, refresh };
    },

    async link(auth, input) {
      const user = await db.user.findFirst({
        where: { id: auth.userId, deletedAt: null },
        select: {
          id: true,
          email: true,
          displayName: true,
          emailVerifiedAt: true,
          passwordHash: true,
        },
      });
      if (user === null) throw unauthenticated();
      // An account whose address nobody has proved may have been registered by someone other
      // than the owner of that address. It must not be able to attach a sign-in method that
      // would survive the real owner's password reset.
      if (user.emailVerifiedAt === null) throw emailNotVerified();
      await reauthenticate(auth, user, input.currentPassword);

      const { provider } = input;
      const credential: OAuthCredential =
        'idToken' in input
          ? { idToken: input.idToken, nonce: input.nonce }
          : {
              code: input.code,
              codeVerifier: input.codeVerifier,
              redirectUri: input.redirectUri,
              state: input.state,
            };
      const identity = await identify(provider, credential);

      const where = {
        provider_providerUserId: { provider, providerUserId: identity.subject },
      } as const;
      const owner = await db.oAuthAccount.findUnique({ where, select: { userId: true } });
      if (owner !== null) {
        if (owner.userId !== user.id) {
          log.info({ event: 'oauth_link_identity_in_use', provider, userId: user.id }, 'refused');
          throw oauthIdentityInUse();
        }
        return methodsOf(user.id); // already linked: nothing to do
      }
      try {
        await db.oAuthAccount.create({
          data: { userId: user.id, provider, providerUserId: identity.subject },
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // Either someone else took the identity a moment ago, or this user already has a
        // different identity of this provider.
        const taken = await db.oAuthAccount.findUnique({ where, select: { userId: true } });
        if (taken !== null && taken.userId !== user.id) throw oauthIdentityInUse();
        if (taken !== null) return methodsOf(user.id);
        throw oauthProviderAlreadyLinked();
      }
      log.info({ event: 'oauth_link', provider, userId: user.id }, 'provider linked');
      notify(user, provider, 'linked');
      return methodsOf(user.id);
    },

    async unlink(auth, provider) {
      // The check ("is there another way in?") and the delete must not interleave with a
      // concurrent unlink of the user's other provider, or both could pass the check and leave
      // the account with nothing. SERIALIZABLE makes PostgreSQL abort one of the two; it is
      // retried and then sees the other's result.
      for (let attempt = 0; ; attempt += 1) {
        try {
          const user = await db.$transaction(
            async (tx) => {
              const account = await tx.user.findFirst({
                where: { id: auth.userId, deletedAt: null },
                select: {
                  email: true,
                  displayName: true,
                  passwordHash: true,
                  oauthAccounts: { select: { provider: true } },
                },
              });
              if (account === null) throw unauthenticated();
              if (!account.oauthAccounts.some((linked) => linked.provider === provider)) {
                throw notFound();
              }
              if (account.passwordHash === null && account.oauthAccounts.length <= 1) {
                throw lastSignInMethod();
              }
              await tx.oAuthAccount.deleteMany({ where: { userId: auth.userId, provider } });
              return account;
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          );
          log.info({ event: 'oauth_unlink', provider, userId: auth.userId }, 'provider unlinked');
          notify(user, provider, 'unlinked');
          return await methodsOf(auth.userId);
        } catch (error) {
          if (isSerializationFailure(error) && attempt < 3) continue;
          throw error;
        }
      }
    },

    methods: methodsOf,

    appleCallbackRedirect(form) {
      // A pure relay: Apple posts here because it returns scoped requests by form POST only,
      // and a single-page app cannot receive a POST. Nothing is exchanged, stored or trusted
      // here; the values travel on to the web app, which finishes with its PKCE verifier. The
      // target is fixed by configuration, so this cannot be used as an open redirect.
      const target = new URL(WEB_OAUTH_CALLBACK_PATH, dependencies.webBaseUrl);
      target.searchParams.set('provider', 'apple');
      const { code, state, error } = form;
      if (state !== undefined && CALLBACK_STATE.test(state)) {
        target.searchParams.set('state', state);
      }
      if (error === undefined && code !== undefined && CALLBACK_CODE.test(code)) {
        target.searchParams.set('code', code);
      } else {
        target.searchParams.set(
          'error',
          error !== undefined && PROVIDER_ERROR.test(error) ? error : 'invalid_response',
        );
      }
      return target.toString();
    },
  };
}
