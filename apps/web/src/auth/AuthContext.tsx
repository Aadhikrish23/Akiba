import type { ApiClient } from '@akiba/api-client';
import type { AuthUser } from '@akiba/shared';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useApi } from '../lib/api';

export type AuthState =
  | { readonly status: 'loading' }
  | { readonly status: 'signed-out' }
  | { readonly status: 'signed-in'; readonly user: AuthUser };

interface AuthValue {
  readonly state: AuthState;
  readonly client: ApiClient;
  /** Re-read the signed-in user (after verifying an email, say). */
  readonly refresh: () => Promise<void>;
  readonly setUser: (user: AuthUser) => void;
}

const AuthContext = createContext<AuthValue | null>(null);

/**
 * Owns "who is signed in". On load it asks the API client to restore the session from the refresh
 * cookie, then follows the client's sign-in / sign-out events (including a session the server
 * ended), so no screen has to track tokens.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const client = useApi();
  const [state, setState] = useState<AuthState>({ status: 'loading' });
  const restored = useRef(false);

  useEffect(() => {
    const off = client.onAuthChange((event) => {
      if (event === 'signed-out') setState({ status: 'signed-out' });
    });
    if (!restored.current) {
      restored.current = true;
      client
        .restoreSession()
        .then((user) => {
          setState(user === undefined ? { status: 'signed-out' } : { status: 'signed-in', user });
        })
        .catch(() => {
          // The server could not be asked; the sign-in screen will say so if it matters.
          setState({ status: 'signed-out' });
        });
    }
    return off;
  }, [client]);

  const value = useMemo<AuthValue>(
    () => ({
      state,
      client,
      setUser: (user) => {
        setState({ status: 'signed-in', user });
      },
      refresh: async () => {
        const user = await client.me();
        setState({ status: 'signed-in', user });
      },
    }),
    [state, client],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (value === null) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}
