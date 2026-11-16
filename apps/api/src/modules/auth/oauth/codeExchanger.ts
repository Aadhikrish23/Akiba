import type { OAuthProvider } from '@akiba/shared';
import { importPKCS8, SignJWT } from 'jose';
import { z } from 'zod';
import type { OAuthConfig } from '../../../config/env.js';
import { APPLE_AUDIENCE, PROVIDER_PROFILES } from './providers.js';

export interface CodeExchangeRequest {
  readonly code: string;
  /** PKCE verifier; the provider checks it against the challenge of the authorization request. */
  readonly codeVerifier: string;
  /** Must equal the redirect URI of the authorization request. */
  readonly redirectUri: string;
}

export type CodeExchangeFailure =
  /** The provider refused the code (wrong, used, expired, wrong verifier or redirect URI). */
  | 'rejected'
  /** The provider could not be reached, answered unexpectedly, or refused OUR credentials. */
  | 'unavailable';

export class OAuthCodeExchangeError extends Error {
  readonly reason: CodeExchangeFailure;
  /** For server logs; never contains the code, the verifier or a secret. */
  readonly detail: string;

  constructor(reason: CodeExchangeFailure, detail: string, cause?: unknown) {
    super(`code exchange ${reason}: ${detail}`, cause === undefined ? undefined : { cause });
    this.name = 'OAuthCodeExchangeError';
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * Seam for swapping an authorization code for the provider's ID token (web flow, doc 09
 * S-AUTH-9). The ID token it returns is NOT trusted until the `OidcVerifier` has checked it.
 */
export interface OAuthCodeExchanger {
  exchange(provider: OAuthProvider, request: CodeExchangeRequest): Promise<{ idToken: string }>;
}

const tokenResponse = z.object({ id_token: z.string().min(1).max(8192) });
const errorResponse = z.object({ error: z.string().regex(/^[a-z_]{1,64}$/) });

/** Token responses are a few KB; anything much larger is not one. */
const MAX_RESPONSE_BYTES = 64 * 1024;
/** Apple accepts client secrets valid for up to six months; one made per request needs minutes. */
const APPLE_CLIENT_SECRET_SECONDS = 5 * 60;

export interface HttpOAuthCodeExchangerOptions {
  readonly config: OAuthConfig;
  readonly now: () => Date;
  /** Milliseconds a token request may take. */
  readonly timeoutMs?: number;
  /** Replaces the providers' token endpoints. For tests against a local HTTP server only. */
  readonly tokenEndpoints?: Partial<Record<OAuthProvider, string>>;
}

/**
 * The real exchanger: one POST to the provider's token endpoint (RFC 6749 §4.1.3 with the PKCE
 * verifier of RFC 7636 §4.5). The client is the FIRST configured client ID of the provider.
 *
 * NOT VERIFIED AGAINST THE REAL PROVIDERS: its requests are checked against a local HTTP server
 * in tests, and the shape follows Google's and Apple's documentation, but no request from this
 * code has ever reached either provider.
 */
export class HttpOAuthCodeExchanger implements OAuthCodeExchanger {
  readonly #options: HttpOAuthCodeExchangerOptions;

  constructor(options: HttpOAuthCodeExchangerOptions) {
    this.#options = options;
  }

  async exchange(
    provider: OAuthProvider,
    request: CodeExchangeRequest,
  ): Promise<{ idToken: string }> {
    const endpoint =
      this.#options.tokenEndpoints?.[provider] ?? PROVIDER_PROFILES[provider].tokenEndpoint;
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: request.code,
      redirect_uri: request.redirectUri,
      code_verifier: request.codeVerifier,
      ...(await this.#clientCredentials(provider)),
    });

    let status: number;
    let text: string;
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'User-Agent': 'akiba-api',
        },
        body: body.toString(),
        // A token endpoint has no reason to redirect; following one could leak the code.
        redirect: 'error',
        signal: AbortSignal.timeout(this.#options.timeoutMs ?? 5_000),
      });
      status = response.status;
      const declared = Number(response.headers.get('content-length') ?? '0');
      if (declared > MAX_RESPONSE_BYTES) {
        throw new Error('token response too large');
      }
      text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) throw new Error('token response too large');
    } catch (error) {
      throw new OAuthCodeExchangeError('unavailable', 'token request failed', error);
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }

    if (status === 200) {
      const parsed = tokenResponse.safeParse(json);
      if (!parsed.success) {
        throw new OAuthCodeExchangeError('unavailable', 'token response without an id_token');
      }
      return { idToken: parsed.data.id_token };
    }

    const failure = errorResponse.safeParse(json);
    const providerError = failure.success ? failure.data.error : 'unparseable';
    // `invalid_grant` is about the code, the verifier or the redirect URI: the caller's problem.
    // Everything else (`invalid_client`, 5xx, …) means this server or the provider is at fault.
    if (status === 400 && providerError === 'invalid_grant') {
      throw new OAuthCodeExchangeError('rejected', providerError);
    }
    throw new OAuthCodeExchangeError('unavailable', `HTTP ${status} ${providerError}`);
  }

  async #clientCredentials(provider: OAuthProvider): Promise<Record<string, string>> {
    const { config, now } = this.#options;
    if (provider === 'google') {
      const clientId = config.google.clientIds[0];
      const { clientSecret } = config.google;
      if (clientId === undefined || clientSecret === undefined) {
        throw new OAuthCodeExchangeError('unavailable', 'google web flow is not configured');
      }
      return { client_id: clientId, client_secret: clientSecret };
    }
    const clientId = config.apple.clientIds[0];
    const key = config.apple.webKey;
    if (clientId === undefined || key === undefined) {
      throw new OAuthCodeExchangeError('unavailable', 'apple web flow is not configured');
    }
    return {
      client_id: clientId,
      client_secret: await appleClientSecret({ ...key, clientId, now: now() }),
    };
  }
}

/**
 * Apple's "client secret" is a short-lived JWT signed with the team's ES256 key
 * (developer.apple.com: "Creating a client secret").
 */
export async function appleClientSecret(input: {
  readonly teamId: string;
  readonly keyId: string;
  readonly privateKeyPem: string;
  readonly clientId: string;
  readonly now: Date;
}): Promise<string> {
  const key = await importPKCS8(input.privateKeyPem, 'ES256');
  const issuedAt = Math.floor(input.now.getTime() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: input.keyId })
    .setIssuer(input.teamId)
    .setSubject(input.clientId)
    .setAudience(APPLE_AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + APPLE_CLIENT_SECRET_SECONDS)
    .sign(key);
}
