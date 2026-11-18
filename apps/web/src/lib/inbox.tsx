import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useAuth } from '../auth/AuthContext';

/** How often the badge is refreshed while the page is open and visible. */
const POLL_MS = 60_000;

interface InboxValue {
  /** Unread notifications; null until the first answer (and after an error before any answer). */
  readonly unread: number | null;
  /** Ask the server again. */
  readonly refresh: () => void;
  /** The Inbox page knows the new number the moment it changes something. */
  readonly setUnread: (count: number | ((current: number | null) => number | null)) => void;
}

const InboxContext = createContext<InboxValue | null>(null);

/**
 * The unread badge (FR-NOTE-003). It asks for the count when the frame opens, when the tab comes
 * back into view and every minute while it is visible. There is no push channel (FR-NOTE-005), so
 * this is how a new episode reaches the badge. A failed request keeps the last number: a badge
 * that vanishes on a network blip would be worse than one a minute stale.
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
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', refresh);
    const timer = window.setInterval(onVisible, POLL_MS);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', refresh);
      window.clearInterval(timer);
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

/** "99+" past 99, so the badge never grows wider than two digits and a plus. */
export const badgeText = (count: number): string => (count > 99 ? '99+' : String(count));
