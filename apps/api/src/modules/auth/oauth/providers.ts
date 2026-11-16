import type { OAuthProvider } from '@akiba/shared';

/**
 * What this API knows about each OpenID Connect provider. These are the providers' published,
 * fixed endpoints; they are constants, not configuration, so that no environment variable can
 * point token verification at someone else's keys.
 */
export interface ProviderProfile {
  /** Accepted `iss` values of ID tokens. */
  readonly issuers: readonly string[];
  /** Where the provider publishes its signing keys. */
  readonly jwksUri: string;
  /** The only signature algorithms accepted from this provider. */
  readonly algorithms: readonly string[];
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  /** Scopes of the web flow: enough for `sub`, the email address and (Google) the name. */
  readonly scope: string;
  /** Extra authorization parameters the provider needs. */
  readonly authorizationParams: Readonly<Record<string, string>>;
}

export const PROVIDER_PROFILES: Readonly<Record<OAuthProvider, ProviderProfile>> = {
  google: {
    // Google documents both spellings of its issuer.
    issuers: ['https://accounts.google.com', 'accounts.google.com'],
    jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
    algorithms: ['RS256'],
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
    authorizationParams: {},
  },
  apple: {
    issuers: ['https://appleid.apple.com'],
    jwksUri: 'https://appleid.apple.com/auth/keys',
    algorithms: ['RS256'],
    authorizationEndpoint: 'https://appleid.apple.com/auth/authorize',
    tokenEndpoint: 'https://appleid.apple.com/auth/token',
    scope: 'name email',
    // Apple returns the code by POST whenever a scope is requested; see the callback relay.
    authorizationParams: { response_mode: 'form_post' },
  },
};

/** `aud` of the client secret Apple's token endpoint expects. */
export const APPLE_AUDIENCE = 'https://appleid.apple.com';
