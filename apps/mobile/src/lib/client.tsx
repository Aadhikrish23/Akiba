import { createApiClient, type ApiClient } from '@akiba/api-client';
import { createContext, useContext, type ReactNode } from 'react';
import { API_BASE_URL, CLIENT_VERSION } from './config';
import { createSecureRefreshTokenStorage } from './secureStorage';

/** The one API client of the app, made once per mounted app (tests make a fresh one each time). */
export function createAppClient(): ApiClient {
  return createApiClient({
    baseUrl: API_BASE_URL,
    platform: 'mobile',
    clientVersion: CLIENT_VERSION,
    refreshTokenStorage: createSecureRefreshTokenStorage(),
    // Looked up on every call, so a test (or a polyfill) installed later is honoured.
    fetch: (input, init) => globalThis.fetch(input, init),
  });
}

const ClientContext = createContext<ApiClient | null>(null);

export function ApiProvider({ client, children }: { client: ApiClient; children: ReactNode }) {
  return <ClientContext.Provider value={client}>{children}</ClientContext.Provider>;
}

export function useApi(): ApiClient {
  const client = useContext(ClientContext);
  if (client === null) throw new Error('useApi must be used inside <ApiProvider>');
  return client;
}
