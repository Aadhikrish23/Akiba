import { useState, type ReactNode } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { Button, Notice } from '../components/ui';
import { describeError } from '../lib/errors';
import { InboxProvider, badgeText, useInbox } from '../lib/inbox';

interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly end?: boolean;
  readonly icon: ReactNode;
}

/** One stroke width and one set of caps for every icon (doc 08 §2: icons are drawn, not glyphs). */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-6 shrink-0 fill-none stroke-current"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

/** Primary destinations. Each later milestone adds its own entry here (Schedule, …). */
const NAV: readonly NavItem[] = [
  {
    to: '/',
    label: 'Home',
    end: true,
    icon: (
      <Icon>
        <path d="M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z" />
      </Icon>
    ),
  },
  {
    to: '/discover',
    label: 'Discover',
    icon: (
      <Icon>
        <circle cx="12" cy="12" r="9" />
        <path d="m15.5 8.5-2 5-5 2 2-5z" />
      </Icon>
    ),
  },
  {
    to: '/library',
    label: 'Library',
    icon: (
      <Icon>
        <rect x="4" y="4" width="4.5" height="16" rx="1" />
        <rect x="10" y="4" width="4.5" height="16" rx="1" />
        <path d="m16.5 6 3.5 1-3 13-3.5-1" />
      </Icon>
    ),
  },
  {
    to: '/inbox',
    label: 'Inbox',
    icon: (
      <Icon>
        <path d="M4 13h4l1.5 3h5L16 13h4" />
        <path d="M5.5 5h13L20 13v6H4v-6z" />
      </Icon>
    ),
  },
  {
    to: '/history',
    label: 'History',
    icon: (
      <Icon>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </Icon>
    ),
  },
  {
    to: '/settings',
    label: 'Settings',
    icon: (
      <Icon>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
      </Icon>
    ),
  },
];

/**
 * The signed-in frame (doc 08 §4): a left rail from 880 px up, a slim top bar and a bottom tab bar
 * below it. It is one `nav`, restyled by width, so there is one set of links to read and test.
 * Everything that is not signed in is bounced to the log-in screen, remembering where it was headed.
 */
export function AppShell() {
  const { state, client, deleting } = useAuth();
  const location = useLocation();
  const [signOutError, setSignOutError] = useState<string | null>(null);

  if (state.status === 'loading') {
    return (
      <p aria-busy="true" role="status" className="text-mute" style={{ padding: 'var(--gutter)' }}>
        Loading…
      </p>
    );
  }
  // A deletion in progress ends the session on purpose; its own screen takes over.
  if (state.status === 'signed-out' && deleting) return null;
  if (state.status === 'signed-out') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  const signOut = () => {
    setSignOutError(null);
    client.auth.logout().catch((error: unknown) => {
      // The local session is gone either way; say so only if the server could not be told.
      setSignOutError(describeError(error).message);
    });
  };

  return (
    <InboxProvider>
      <div className="min-h-dvh min-[880px]:grid min-[880px]:grid-cols-[104px_1fr]">
        <a
          href="#main"
          className="bg-ink text-paper absolute -top-20 left-2 z-50 rounded-sm px-4 py-2 focus:top-2"
        >
          Skip to content
        </a>
        <header
          className="border-rule flex items-center gap-x-4 border-b min-[880px]:sticky min-[880px]:top-0 min-[880px]:h-dvh min-[880px]:flex-col min-[880px]:items-center min-[880px]:justify-start min-[880px]:gap-1 min-[880px]:border-r min-[880px]:border-b-0 min-[880px]:py-5"
          style={{ padding: '10px var(--gutter)' }}
        >
          <Link
            to="/"
            aria-label="Akiba"
            className="bg-accent text-on-accent grid size-11 shrink-0 -rotate-3 place-items-center rounded-md font-display text-3xl leading-none font-black min-[880px]:mb-5 min-[880px]:size-[52px]"
          >
            <span lang="ja" aria-hidden="true">
              秋
            </span>
          </Link>
          <nav
            aria-label="Main"
            className="border-rule bg-paper fixed inset-x-0 bottom-0 z-40 flex justify-around border-t px-1.5 pt-1.5 pb-[calc(6px+env(safe-area-inset-bottom))] min-[880px]:static min-[880px]:z-auto min-[880px]:flex-col min-[880px]:items-center min-[880px]:justify-start min-[880px]:gap-1 min-[880px]:border-0 min-[880px]:bg-transparent min-[880px]:p-0"
          >
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end === true}
                className={({ isActive }) =>
                  `relative flex flex-1 flex-col items-center gap-0.5 rounded-md px-1 py-2 text-xs font-medium min-[880px]:w-[76px] min-[880px]:flex-none ${
                    isActive ? 'bg-raised text-accent' : 'text-mute hover:text-ink'
                  }`
                }
              >
                {item.icon}
                {item.to === '/inbox' ? <InboxLabel label={item.label} /> : item.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto grid justify-items-end gap-0.5 text-sm min-[880px]:mt-auto min-[880px]:ml-0 min-[880px]:justify-items-center min-[880px]:text-center">
            <span
              className="text-mute max-w-[8rem] truncate text-xs min-[880px]:max-w-[88px]"
              data-testid="account-name"
            >
              {state.user.displayName ?? state.user.email}
            </span>
            <Button variant="link" onClick={signOut} className="whitespace-nowrap">
              Log out
            </Button>
          </div>
        </header>
        <div className="min-w-0 pb-24 min-[880px]:pb-0">
          {!state.user.emailVerified && <VerifyBanner />}
          {signOutError !== null && (
            <div style={{ padding: '16px var(--gutter) 0' }}>
              <Notice tone="error">{signOutError}</Notice>
            </div>
          )}
          <main id="main" tabIndex={-1} style={{ padding: '28px var(--gutter)' }}>
            <Outlet />
          </main>
        </div>
      </div>
    </InboxProvider>
  );
}

/** "Inbox" with the unread count; the count is words for a screen reader, not just a number. */
function InboxLabel({ label }: { label: string }) {
  const { unread } = useInbox();
  return (
    <>
      {label}{' '}
      {unread !== null && unread > 0 && (
        <span className="bg-accent text-on-accent absolute top-0.5 right-2 inline-grid h-5 min-[880px]:right-3 min-w-5 place-items-center rounded-full px-1.5 text-xs leading-none font-bold">
          {badgeText(unread)} <span className="sr-only">unread</span>
        </span>
      )}
    </>
  );
}

/** Q-04: an unverified account can use Akiba, but sharing needs a verified address. */
function VerifyBanner() {
  const { client } = useAuth();
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const resend = () => {
    setStatus('sending');
    client.auth
      .resendVerification()
      .then(() => {
        setStatus('sent');
      })
      .catch(() => {
        setStatus('error');
      });
  };
  return (
    <div
      className="border-rule bg-raised flex flex-wrap items-center gap-x-4 gap-y-1 border-b text-sm"
      style={{ padding: '10px var(--gutter)' }}
    >
      <p>Verify your email address to enable sharing. We sent you a link when you signed up.</p>
      {status === 'sent' ? (
        <p role="status">A new link is on its way.</p>
      ) : (
        <Button variant="link" onClick={resend} busy={status === 'sending'}>
          Send the link again
        </Button>
      )}
      {status === 'error' && <p role="alert">Could not send the link. Try again later.</p>}
    </div>
  );
}
