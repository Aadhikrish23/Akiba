import { APP_NAME, type Platform } from '@akiba/shared';

export interface ApiClientOptions {
  /** Absolute origin (and optional base path) of the API, e.g. `https://api.example.com/v1`. */
  readonly baseUrl: string;
  readonly platform: Platform;
}

export interface ApiClient {
  readonly platform: Platform;
  /** Value sent as `User-Agent`-style client identification. */
  readonly clientName: string;
  /** Resolve an API path against the configured base URL. */
  url(path: string): string;
}

/**
 * Placeholder client: it only resolves URLs. Request methods are added in T7
 * alongside the shared DTO schemas.
 */
export function createApiClient(options: ApiClientOptions): ApiClient {
  const base = new URL(options.baseUrl);
  const basePath = base.pathname.replace(/\/+$/, '');

  return {
    platform: options.platform,
    clientName: `${APP_NAME}/${options.platform}`,
    url(path) {
      const suffix = path.startsWith('/') ? path : `/${path}`;
      return `${base.origin}${basePath}${suffix}`;
    },
  };
}
