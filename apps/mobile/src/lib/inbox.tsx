import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';
import { useAuth } from '../auth/AuthContext';

/** How often the badge is refreshed while the app is in the foreground. */
const POLL_MS = 60_000;

interface InboxValue {
  /** Unread notifications; null until the first answer. */
  readonly unread: number | null;
  readonly refresh: () => void;
  /** The Inbox screen knows the new number the moment it changes something. */
  readonly setUnread: (count: number | ((current: number | null) => number | null)) => void;
}

const InboxContext = createContext<InboxValue | null>(null);

/**
 * The unread badge on the Inbox tab (FR-NOTE-003). It asks for the count when the app opens, when
 * it comes back to the foreground and every minute while it is there. There is no push channel
 * (FR-NOTE-005). A failed request keeps the last number: a badge that vanishes on a network blip
 * would be worse than one a minute stale.
 */
export function InboxProvider({ children }: { children: ReactNode }) {
  const { client } = useAuth();
  const [unread, setUnread] = useState<number | null>(null);

  const refresh = useCallback(() => {
    client.inbox
      .unreadCount()
      .then(setUnread)
      .catch(() => {
        // Keep whatever is shown.
      });
  }, [client]);

  useEffect(() => {
    refresh();
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') refresh();
    });
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') refresh();
    }, POLL_MS);
    return () => {
      subscription.remove();
      clearInterval(timer);
    };
  }, [refresh]);

  const value = useMemo<InboxValue>(() => ({ unread, refresh, setUnread }), [unread, refresh]);
  return <InboxContext.Provider value={value}>{children}</InboxContext.Provider>;
}

export function useInbox(): InboxValue {
  const value = useContext(InboxContext);
  if (value === null) throw new Error('useInbox must be used inside <InboxProvider>');
  return value;
}
