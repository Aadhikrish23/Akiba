import { createApiClient, type ApiClient } from '@akiba/api-client';
import { createContext, useContext, type ReactNode } from 'react';

/** The API lives next to the web app (`/v1`); in development Vite proxies it (vite.config.ts). */
export function createBrowserClient(): ApiClient {
  const baseUrl =
    (import.meta.env['VITE_API_URL'] as string | undefined) ?? `${window.location.origin}/v1`;
  return createApiClient({ baseUrl, platform: 'web', clientVersion: '0.1.0' });
}

const ApiContext = createContext<ApiClient | null>(null);

export function ApiProvider({ client, children }: { client: ApiClient; children: ReactNode }) {
  return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>;
}

export function useApi(): ApiClient {
  const client = useContext(ApiContext);
  if (client === null) throw new Error('useApi must be used inside <ApiProvider>');
  return client;
}
