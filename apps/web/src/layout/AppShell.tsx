import { useState } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { Button, Notice } from '../components/ui';
import { describeError } from '../lib/errors';

/** Primary destinations. Each later milestone adds its own entry here (Discover, Library, …). */
const NAV: readonly { readonly to: string; readonly label: string; readonly end?: boolean }[] = [
  { to: '/', label: 'Home', end: true },
];

const navClass = ({ isActive }: { isActive: boolean }): string =>
  `block py-2 text-base ${
    isActive ? 'border-accent border-b-2 font-medium' : 'border-b-2 border-transparent'
  }`;

/**
 * The signed-in frame (doc 08 §4): sidebar from 880 px up, a top bar below it. Everything that is
 * not signed in is bounced to the log-in screen, remembering where it was headed.
 */
export function AppShell() {
  const { state, client } = useAuth();
  const location = useLocation();
  const [signOutError, setSignOutError] = useState<string | null>(null);

  if (state.status === 'loading') {
    return (
      <p aria-busy="true" role="status" className="text-mute" style={{ padding: 'var(--gutter)' }}>
        Loading…
      </p>
    );
  }
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
    <div className="min-h-dvh min-[880px]:grid min-[880px]:grid-cols-[220px_1fr]">
      <a
        href="#main"
        className="bg-ink text-paper absolute -top-20 left-2 z-10 rounded-sm px-4 py-2 focus:top-2"
      >
        Skip to content
      </a>
      <header
        className="border-rule flex flex-wrap items-center gap-x-6 gap-y-2 border-b min-[880px]:flex-col min-[880px]:items-start min-[880px]:justify-start min-[880px]:border-r min-[880px]:border-b-0"
        style={{ padding: '14px var(--gutter)' }}
      >
        <Link to="/" className="font-serif text-lg font-semibold tracking-tight">
          Akiba <span lang="ja">秋葉</span>
        </Link>
        <nav
          aria-label="Main"
          className="flex gap-5 min-[880px]:mt-6 min-[880px]:flex-col min-[880px]:gap-1"
        >
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end === true} className={navClass}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto grid gap-1 text-sm min-[880px]:mt-auto min-[880px]:ml-0">
          <span className="text-mute" data-testid="account-name">
            {state.user.displayName ?? state.user.email}
          </span>
          <Button variant="link" onClick={signOut}>
            Log out
          </Button>
        </div>
      </header>
      <div>
        {!state.user.emailVerified && <VerifyBanner />}
        {signOutError !== null && (
          <div style={{ padding: '16px var(--gutter) 0' }}>
            <Notice tone="error">{signOutError}</Notice>
          </div>
        )}
        <main id="main" tabIndex={-1} style={{ padding: '32px var(--gutter)' }}>
          <Outlet />
        </main>
      </div>
    </div>
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
      className="border-rule flex flex-wrap items-center gap-x-4 gap-y-1 border-b text-sm"
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
