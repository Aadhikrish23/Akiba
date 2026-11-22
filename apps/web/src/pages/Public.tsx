import { ApiError } from '@akiba/api-client';
import type { SharedEntry, SharedListResponse } from '@akiba/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { Button, Field, Notice } from '../components/ui';
import { AuthLayout } from '../layout/AuthLayout';
import { describeError, describeIssues } from '../lib/errors';
import { usePageTitle } from '../lib/page';
import { ENTRY_LABEL, displayTitle, metaLine } from '../lib/titles';
import { loginRequestSchema } from '@akiba/shared';

/** A page that must not be indexed and must not tell other sites where it was opened from. */
function useRobotsAndReferrer(): void {
  useEffect(() => {
    const robots = document.createElement('meta');
    robots.name = 'robots';
    robots.content = 'noindex, nofollow';
    const referrer = document.createElement('meta');
    referrer.name = 'referrer';
    referrer.content = 'no-referrer';
    document.head.append(robots, referrer);
    return () => {
      robots.remove();
      referrer.remove();
    };
  }, []);
}

function SharedRow({
  entry,
  ratings,
  reviews,
}: {
  entry: SharedEntry;
  ratings: boolean;
  reviews: boolean;
}) {
  return (
    <li className="border-rule grid grid-cols-[44px_1fr] gap-x-4 gap-y-1 border-b py-3">
      {entry.title.coverUrl === null ? (
        <div className="bg-raised border-rule h-16 w-11 rounded-sm border" aria-hidden="true" />
      ) : (
        <img
          src={entry.title.coverUrl}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="h-16 w-11 rounded-sm object-cover"
        />
      )}
      <div>
        <p className="h-item">{displayTitle(entry.title)}</p>
        <p className="text-mute text-sm tabular-nums">
          {ENTRY_LABEL[entry.status]} · {entry.progress} / {entry.effectiveTotal ?? '?'} ·{' '}
          {metaLine(entry.title)}
          {entry.isFavorite && ' · Favorite'}
          {ratings && entry.rating != null && ` · ${entry.rating} / 10`}
        </p>
        {reviews && entry.review != null && entry.review !== '' && (
          <p className="mt-1 max-w-prose whitespace-pre-line">{entry.review}</p>
        )}
      </div>
    </li>
  );
}

/**
 * The public shared list (FR-SHARE-001…003): no account, read-only, only what the owner chose. It
 * lives outside the signed-in frame and never shows who is looking.
 */
export function SharedPage() {
  const { token = '' } = useParams();
  const { client } = useAuth();
  usePageTitle('Shared list');
  useRobotsAndReferrer();
  const [result, setResult] = useState<SharedListResponse | 'missing' | 'error' | null>(null);
  const [more, setMore] = useState<SharedEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    client.account
      .shared(token)
      .then((response) => {
        if (live) {
          setResult(response);
          setCursor(response.nextCursor);
        }
      })
      .catch((error: unknown) => {
        if (live)
          setResult(error instanceof ApiError && error.status === 404 ? 'missing' : 'error');
      });
    return () => {
      live = false;
    };
  }, [client, token]);

  return (
    <div className="min-h-dvh">
      <header className="border-rule border-b" style={{ padding: '14px var(--gutter)' }}>
        <span className="h-item">
          Akiba <span lang="ja">秋葉</span>
        </span>
      </header>
      <main
        id="main"
        className="mx-auto w-full max-w-3xl"
        style={{ padding: '40px var(--gutter)' }}
      >
        {result === null && (
          <p role="status" aria-busy="true" className="text-mute">
            Loading…
          </p>
        )}
        {result === 'missing' && (
          <>
            <h1 className="h-title">This list is not available</h1>
            <p className="text-mute mt-2">
              The link may have been turned off, or it is not correct.
            </p>
          </>
        )}
        {result === 'error' && (
          <Notice tone="error">The list could not be loaded. Try again in a moment.</Notice>
        )}
        {result !== null && result !== 'missing' && result !== 'error' && (
          <>
            <h1 className="h-title">
              {result.owner.displayName === null
                ? 'A shared list'
                : `${result.owner.displayName}'s list`}
            </h1>
            <p className="text-mute mt-1 text-sm">
              Showing: {result.scope.statuses.map((status) => ENTRY_LABEL[status]).join(', ')}.
            </p>
            {result.data.length + more.length === 0 ? (
              <p className="text-mute mt-6">Nothing to show here yet.</p>
            ) : (
              <ul aria-label="Shared titles" className="mt-6 list-none p-0">
                {[...result.data, ...more].map((entry, index) => (
                  <SharedRow
                    key={`${entry.title.id}-${index}`}
                    entry={entry}
                    ratings={result.scope.showRatings}
                    reviews={result.scope.showReviews}
                  />
                ))}
              </ul>
            )}
            {cursor !== null && (
              <div className="mt-6">
                <Button
                  onClick={() => {
                    client.account
                      .shared(token, { cursor })
                      .then((page) => {
                        setMore((current) => [...current, ...page.data]);
                        setCursor(page.nextCursor);
                      })
                      .catch(() => {
                        setCursor(null);
                      });
                  }}
                >
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

/** Shown after a deletion is scheduled: what happens next, and how to undo it. */
export function AccountDeletedPage() {
  const location = useLocation();
  const purgeAfter = (location.state as { purgeAfter?: string } | null)?.purgeAfter;
  return (
    <AuthLayout title="Your account is scheduled for deletion">
      <Notice tone="success">
        You are logged out everywhere
        {purgeAfter === undefined
          ? ''
          : ` and your data will be erased after ${new Date(purgeAfter).toLocaleDateString(undefined, { dateStyle: 'long' })}`}
        .
      </Notice>
      <p>
        Changed your mind?{' '}
        <Link to="/restore" className="underline underline-offset-4">
          Restore your account
        </Link>{' '}
        before then.
      </p>
    </AuthLayout>
  );
}

/** Undo a deletion inside the grace period. The account cannot sign in until it is restored. */
export function RestorePage() {
  const { client } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  if (done) {
    return (
      <AuthLayout title="Account restored">
        <Notice tone="success">
          Your account and everything in it is back. Share links you had before stay off.
        </Notice>
        <p>
          <Link to="/login" className="underline underline-offset-4">
            Log in
          </Link>
        </p>
      </AuthLayout>
    );
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = loginRequestSchema.safeParse({ email, password });
    if (!parsed.success) {
      setFields(describeIssues(parsed.error.issues));
      setProblem('Check the highlighted fields.');
      return;
    }
    setFields({});
    setProblem(null);
    setBusy(true);
    client.auth
      .restoreAccount(parsed.data)
      .then(() => {
        setDone(true);
      })
      .catch((error: unknown) => {
        const described = describeError(error);
        setProblem(
          error instanceof ApiError && error.status === 401
            ? 'We could not restore an account with those details. The 14 days may be over.'
            : described.message,
        );
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <AuthLayout
      title="Restore your account"
      intro="Use the email and password of the account you deleted, within 14 days."
    >
      <form onSubmit={submit} noValidate className="grid gap-5">
        {problem !== null && <Notice tone="error">{problem}</Notice>}
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
          }}
          error={fields['email']}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
          error={fields['password']}
        />
        <div>
          <Button type="submit" variant="primary" busy={busy}>
            Restore account
          </Button>
        </div>
      </form>
    </AuthLayout>
  );
}
