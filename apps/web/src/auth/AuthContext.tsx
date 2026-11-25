import type { ApiClient } from '@akiba/api-client';
import type { AuthUser, Profile, UpdateProfileRequest } from '@akiba/shared';
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
import { setTitleLanguage } from '../lib/titles';

export type AuthState =
  | { readonly status: 'loading' }
  | { readonly status: 'signed-out' }
  | { readonly status: 'signed-in'; readonly user: AuthUser };

interface AuthValue {
  readonly state: AuthState;
  readonly client: ApiClient;
  /** The signed-in user's settings; null until they have been read (right after logging in). */
  readonly profile: Profile | null;
  /** Re-read the signed-in user (after verifying an email, say). */
  readonly refresh: () => Promise<void>;
  readonly setUser: (user: AuthUser) => void;
  /** True while the user is deleting their account, so the frame does not bounce them to log in. */
  readonly deleting: boolean;
  readonly setDeleting: (value: boolean) => void;
  /** Change settings; the screen reflects the saved result. */
  readonly updateProfile: (changes: UpdateProfileRequest) => Promise<Profile>;
}

const AuthContext = createContext<AuthValue | null>(null);

/**
 * Owns "who is signed in". On load it asks the API client to restore the session from the refresh
 * cookie, then follows the client's sign-in / sign-out events (including a session the server
 * ended), so no screen has to track tokens. It also holds the user's settings (view, language…).
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const client = useApi();
  const [state, setState] = useState<AuthState>({ status: 'loading' });
  const [profile, setProfile] = useState<Profile | null>(null);
  const [deleting, setDeleting] = useState(false);
  const restored = useRef(false);

  useEffect(() => {
    const off = client.onAuthChange((event) => {
      if (event === 'signed-out') {
        setState({ status: 'signed-out' });
        setProfile(null);
      }
    });
    if (!restored.current) {
      restored.current = true;
      client
        .restoreSession()
        .then((user) => {
          if (user === undefined) setState({ status: 'signed-out' });
          else {
            setProfile(user);
            setState({ status: 'signed-in', user });
          }
        })
        .catch(() => {
          // The server could not be asked; the sign-in screen will say so if it matters.
          setState({ status: 'signed-out' });
        });
    }
    return off;
  }, [client]);

  // The title-language setting changes how every title is named. It is set while rendering, before
  // any screen below reads a name, so a page that loads with the account (or right after the
  // settings arrive) never paints one frame in the wrong language.
  if (profile !== null) setTitleLanguage(profile.titleLanguage);

  // Login answers with identity only; the settings come from one more read.
  const signedIn = state.status === 'signed-in';
  useEffect(() => {
    if (!signedIn || profile !== null) return;
    let live = true;
    client
      .me()
      .then((next) => {
        if (live) setProfile(next);
      })
      .catch(() => {
        // Defaults apply until the next successful read.
      });
    return () => {
      live = false;
    };
  }, [client, signedIn, profile]);

  const value = useMemo<AuthValue>(
    () => ({
      state,
      client,
      profile,
      deleting,
      setDeleting,
      setUser: (user) => {
        setState({ status: 'signed-in', user });
      },
      refresh: async () => {
        const user = await client.me();
        setProfile(user);
        setState({ status: 'signed-in', user });
      },
      updateProfile: async (changes) => {
        const next = await client.account.updateProfile(changes);
        setProfile(next);
        return next;
      },
    }),
    [state, client, profile, deleting],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (value === null) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}
