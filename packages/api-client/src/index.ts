import {
  APP_NAME,
  CLIENT_HEADER,
  CLIENT_HEADER_PATTERN,
  healthResponseSchema,
  loginResponseSchema,
  meResponseSchema,
  problemDocumentSchema,
  readyResponseSchema,
  refreshResponseSchema,
  registerResponseSchema,
  resetPasswordResponseSchema,
  verifyEmailResponseSchema,
  acceptedResponseSchema,
  type AcceptedResponse,
  type AuthUser,
  type ChangePasswordRequest,
  type ForgotPasswordRequest,
  type HealthResponse,
  type LoginRequest,
  type MeResponse,
  type Platform,
  type ReadyResponse,
  type RefreshResponse,
  type RegisterRequest,
  type RegisterResponse,
  type ResetPasswordRequest,
  type ResetPasswordResponse,
  type VerifyEmailResponse,
} from '@akiba/shared';
import { ApiError, ContractError, NetworkError, NotSignedInError } from './errors.js';

export { ApiError, ContractError, NetworkError, NotSignedInError } from './errors.js';

/** Where a mobile client keeps its refresh token (SecureStore on a device). Web/desktop never use it. */
export interface RefreshTokenStorage {
  get(): Promise<string | undefined> | string | undefined;
  /** `undefined` deletes the token. */
  set(token: string | undefined): Promise<void> | void;
}

export type AuthEvent = 'signed-in' | 'signed-out';

export interface ApiClientOptions {
  /** Absolute origin (and optional base path) of the API, e.g. `https://api.example.com/v1`. */
  readonly baseUrl: string;
  readonly platform: Platform;
  /** App version, sent as `X-Client: <platform>/<version>`. Must match the API's header pattern. */
  readonly clientVersion?: string;
  /** Defaults to the global `fetch`. Tests and React Native shims inject their own. */
  readonly fetch?: typeof fetch;
  /** Mobile only. Defaults to memory, so the session ends with the process. */
  readonly refreshTokenStorage?: RefreshTokenStorage;
  /** Per-request timeout. Default 15 s. */
  readonly timeoutMs?: number;
  /** Clock in ms since the epoch; tests move it by hand. */
  readonly now?: () => number;
  /**
   * Runs a token renewal exclusively across every copy of the client that shares one refresh
   * token (browser tabs). Without it two tabs can renew at the same moment, one of them presents a
   * token the other has just retired, and the server ends the session as theft. The browser app
   * passes a Web Locks wrapper; a single-process client needs none.
   */
  readonly refreshLock?: <T>(operation: () => Promise<T>) => Promise<T>;
}

export interface AuthApi {
  /** Always resolves with the same body, whether or not the address already had an account. */
  register(request: RegisterRequest): Promise<RegisterResponse>;
  /** Starts a session and resolves with the signed-in user. Tokens stay inside the client. */
  login(request: LoginRequest): Promise<AuthUser>;
  /** Ends this session. The local session is cleared even if the server cannot be reached. */
  logout(): Promise<void>;
  /** Ends every session of the account. */
  logoutAll(): Promise<void>;
  verifyEmail(token: string): Promise<VerifyEmailResponse>;
  resendVerification(): Promise<AcceptedResponse>;
  /** Always resolves with the same body; says nothing about whether the account exists. */
  forgotPassword(request: ForgotPasswordRequest): Promise<AcceptedResponse>;
  /** Ends every session, including this client's. */
  resetPassword(request: ResetPasswordRequest): Promise<ResetPasswordResponse>;
  /** Other sessions end; this one continues. */
  changePassword(request: ChangePasswordRequest): Promise<void>;
}

export interface ApiClient {
  readonly platform: Platform;
  /** Value of the client name used in logs and `User-Agent`-style identification. */
  readonly clientName: string;
  /** Resolve an API path against the configured base URL. */
  url(path: string): string;
  readonly auth: AuthApi;
  /** `GET /me`. Refreshes the session first if needed. */
  me(): Promise<MeResponse>;
  /**
   * Bring a session back after a restart: web/desktop through the refresh cookie, mobile through
   * the stored refresh token. Resolves with the user, or `undefined` when nobody is signed in.
   * Network and server errors are thrown (they say nothing about whether a session exists).
   */
  restoreSession(): Promise<AuthUser | undefined>;
  isSignedIn(): boolean;
  /** Subscribe to sign-in / sign-out (including a session the server ended). Returns unsubscribe. */
  onAuthChange(listener: (event: AuthEvent) => void): () => void;
  /** `GET /health` (liveness; at the API origin, outside `/v1`). */
  health(): Promise<HealthResponse>;
  /** `GET /ready` (readiness). A 503 rejects with an {@link ApiError} coded `NOT_READY`. */
  ready(): Promise<ReadyResponse>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
/** An access token this close to expiry is renewed before use, not after a 401. */
const EXPIRY_MARGIN_MS = 30_000;

interface Parser<T> {
  safeParse(
    value: unknown,
  ): { success: true; data: T } | { success: false; error: { message: string } };
}

interface CallOptions {
  readonly method: 'GET' | 'POST';
  /** Relative to the base URL, or to the API origin when `root` is set. */
  readonly path: string;
  readonly root?: boolean;
  readonly body?: unknown;
  /** Send the access token and renew it when needed. */
  readonly authenticated?: boolean;
}

function retryAfterSeconds(response: Response): number | undefined {
  const value = response.headers.get('Retry-After');
  if (value === null) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function toApiError(response: Response, json: unknown): ApiError {
  const parsed = problemDocumentSchema.safeParse(json);
  const retryAfter = retryAfterSeconds(response);
  if (parsed.success) {
    const problem = parsed.data;
    return new ApiError({
      status: response.status,
      code: problem.code,
      title: problem.title,
      detail: problem.detail,
      errors: problem.errors,
      requestId: problem.requestId,
      retryAfterSeconds: retryAfter,
      problem,
    });
  }
  return new ApiError({
    status: response.status,
    code: 'UNEXPECTED_RESPONSE',
    title: response.statusText || 'Unexpected response',
    detail: `The server answered ${response.status} without a problem document.`,
    retryAfterSeconds: retryAfter,
  });
}

function parse<T>(parser: Parser<T>, path: string, json: unknown): T {
  const result = parser.safeParse(json);
  if (!result.success) throw new ContractError(path, result.error.message);
  return result.data;
}

/**
 * The typed client of the Akiba API. It owns the session: the access token lives in memory only,
 * the refresh token travels in the HttpOnly cookie (web, desktop) or in the injected storage
 * (mobile), and a request that finds the token expired renews it first. Concurrent renewals are
 * merged into one, because the server treats a second use of a refresh token as theft and ends
 * the whole session family (doc 09 S-AUTH-5).
 */
export function createApiClient(options: ApiClientOptions): ApiClient {
  const base = new URL(options.baseUrl);
  const basePath = base.pathname.replace(/\/+$/, '');
  const { platform } = options;
  const transport = platform === 'mobile' ? 'body' : 'cookie';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const fetchImpl: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  const clientHeader =
    options.clientVersion === undefined ? platform : `${platform}/${options.clientVersion}`;
  if (!CLIENT_HEADER_PATTERN.test(clientHeader)) {
    throw new TypeError(`clientVersion "${options.clientVersion}" is not a valid client version`);
  }

  let memoryRefreshToken: string | undefined;
  const storage: RefreshTokenStorage = options.refreshTokenStorage ?? {
    get: () => memoryRefreshToken,
    set: (token) => {
      memoryRefreshToken = token;
    },
  };

  let accessToken: string | undefined;
  let accessTokenExpiresAt = 0;
  let refreshing: Promise<void> | undefined;
  const listeners = new Set<(event: AuthEvent) => void>();

  const emit = (event: AuthEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // A faulty subscriber must not break the request that triggered the event.
      }
    }
  };

  const url = (path: string): string => {
    const suffix = path.startsWith('/') ? path : `/${path}`;
    return `${base.origin}${basePath}${suffix}`;
  };

  /** One HTTP exchange: no session logic. Resolves with the parsed JSON body (undefined if none). */
  async function execute(req: CallOptions, bearer: string | undefined): Promise<unknown> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      [CLIENT_HEADER]: clientHeader,
    };
    if (bearer !== undefined) headers['Authorization'] = `Bearer ${bearer}`;
    let body: string | undefined;
    if (req.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(req.body);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      let response: Response;
      let text: string;
      try {
        response = await fetchImpl(
          req.root === true ? `${base.origin}${req.path}` : url(req.path),
          {
            method: req.method,
            headers,
            ...(body === undefined ? {} : { body }),
            credentials: transport === 'cookie' ? 'include' : 'omit',
            signal: controller.signal,
          },
        );
        text = await response.text();
      } catch (cause) {
        const timedOut = controller.signal.aborted;
        throw new NetworkError(
          timedOut ? `Request timed out after ${timeoutMs} ms` : 'Network request failed',
          { timedOut, cause },
        );
      }
      let json: unknown;
      if (text !== '') {
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
      }
      if (!response.ok) throw toApiError(response, json);
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  const endSession = async (): Promise<void> => {
    const wasSignedIn = accessToken !== undefined;
    accessToken = undefined;
    accessTokenExpiresAt = 0;
    await storage.set(undefined);
    if (wasSignedIn) emit('signed-out');
  };

  const acceptTokens = async (tokens: RefreshResponse): Promise<void> => {
    if (transport === 'body') {
      if (tokens.refreshToken === undefined) {
        throw new ContractError('/auth', 'a mobile client must receive a refreshToken');
      }
      await storage.set(tokens.refreshToken);
    }
    const wasSignedIn = accessToken !== undefined;
    accessToken = tokens.accessToken;
    accessTokenExpiresAt = now() + tokens.expiresIn * 1000;
    if (!wasSignedIn) emit('signed-in');
  };

  async function renewSession(): Promise<void> {
    let body: { refreshToken: string } | undefined;
    if (transport === 'body') {
      const stored = await storage.get();
      if (stored === undefined) {
        await endSession();
        throw new NotSignedInError();
      }
      body = { refreshToken: stored };
    }
    try {
      const json = await execute(
        { method: 'POST', path: '/auth/refresh', ...(body === undefined ? {} : { body }) },
        undefined,
      );
      await acceptTokens(parse(refreshResponseSchema, '/auth/refresh', json));
    } catch (error) {
      // Only the server saying "this session is over" ends it. A dropped connection or a 5xx
      // says nothing about the session, so it stays and the caller may try again.
      if (error instanceof ApiError && error.status === 401) await endSession();
      throw error;
    }
  }

  /** Every caller waits for the same renewal; a second refresh would be read as token reuse. */
  const renew = (): Promise<void> => {
    refreshing ??= (options.refreshLock?.(renewSession) ?? renewSession()).finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  };

  async function call(req: CallOptions): Promise<unknown> {
    if (req.authenticated !== true) return execute(req, undefined);

    if (accessToken === undefined || accessTokenExpiresAt - EXPIRY_MARGIN_MS <= now()) {
      await renew();
    }
    const used = accessToken;
    if (used === undefined) throw new NotSignedInError();
    try {
      return await execute(req, used);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      // The server refused the token (revoked, or its clock differs). Renew once and retry once,
      // unless a concurrent call has already replaced the token we used.
      if (accessToken === used) await renew();
      const renewed = accessToken;
      if (renewed === undefined) throw error;
      return execute(req, renewed);
    }
  }

  const post = (path: string, body?: unknown, authenticated = false): Promise<unknown> =>
    call({ method: 'POST', path, authenticated, ...(body === undefined ? {} : { body }) });

  const me = async (): Promise<MeResponse> =>
    parse(meResponseSchema, '/me', await call({ method: 'GET', path: '/me', authenticated: true }));

  const auth: AuthApi = {
    async register(request) {
      return parse(registerResponseSchema, '/auth/register', await post('/auth/register', request));
    },

    async login(request) {
      const json = await post('/auth/login', request);
      const login = parse(loginResponseSchema, '/auth/login', json);
      await acceptTokens(login);
      return login.user;
    },

    async logout() {
      let body: { refreshToken: string } | undefined;
      if (transport === 'body') {
        const stored = await storage.get();
        if (stored !== undefined) body = { refreshToken: stored };
      }
      try {
        await post('/auth/logout', body);
      } finally {
        await endSession();
      }
    },

    async logoutAll() {
      await post('/auth/logout-all', undefined, true);
      await endSession();
    },

    async verifyEmail(token) {
      return parse(
        verifyEmailResponseSchema,
        '/auth/verify-email',
        await post('/auth/verify-email', { token }),
      );
    },

    async resendVerification() {
      return parse(
        acceptedResponseSchema,
        '/auth/verify-email/resend',
        await post('/auth/verify-email/resend', undefined, true),
      );
    },

    async forgotPassword(request) {
      return parse(
        acceptedResponseSchema,
        '/auth/password/forgot',
        await post('/auth/password/forgot', request),
      );
    },

    async resetPassword(request) {
      const result = parse(
        resetPasswordResponseSchema,
        '/auth/password/reset',
        await post('/auth/password/reset', request),
      );
      // The server ended every session of the account, this one included.
      await endSession();
      return result;
    },

    async changePassword(request) {
      await post('/auth/password/change', request, true);
    },
  };

  return {
    platform,
    clientName: `${APP_NAME}/${platform}`,
    url,
    auth,
    me,

    async restoreSession() {
      try {
        await renew();
      } catch (error) {
        if (error instanceof NotSignedInError) return undefined;
        if (error instanceof ApiError && error.status === 401) return undefined;
        throw error;
      }
      return me();
    },

    isSignedIn: () => accessToken !== undefined,

    onAuthChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async health() {
      return parse(
        healthResponseSchema,
        '/health',
        await call({ method: 'GET', path: '/health', root: true }),
      );
    },

    async ready() {
      return parse(
        readyResponseSchema,
        '/ready',
        await call({ method: 'GET', path: '/ready', root: true }),
      );
    },
  };
}
