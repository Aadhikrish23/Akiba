import type { LibraryEntry } from '@akiba/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { ContinueCard } from '../components/EntryParts';
import { Button, Notice } from '../components/ui';
import { describeError } from '../lib/errors';
import { usePageTitle } from '../lib/page';

/** Home: what to watch next. "Continue watching" with +1 on each card (doc 08 key flow 1). */
export function HomePage() {
  usePageTitle('Home');
  const { state, client } = useAuth();
  const name = state.status === 'signed-in' ? (state.user.displayName ?? 'there') : 'there';
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setError(null);
    client.library
      .list({ status: 'watching', sort: 'updated', limit: 8 })
      .then((response) => {
        if (live) setEntries(response.data);
      })
      .catch((caught: unknown) => {
        if (live) setError(describeError(caught).message);
      });
    return () => {
      live = false;
    };
  }, [client, attempt]);

  return (
    <div className="grid max-w-3xl gap-8">
      <h1 className="font-serif text-2xl font-semibold tracking-tight">Welcome, {name}</h1>
      <section aria-labelledby="continue-heading" className="grid gap-2">
        <h2 id="continue-heading" className="font-serif text-xl font-semibold">
          Continue watching
        </h2>
        {error !== null && (
          <div className="grid gap-3">
            <Notice tone="error">{error}</Notice>
            <div>
              <Button
                onClick={() => {
                  setAttempt((value) => value + 1);
                }}
              >
                Try again
              </Button>
            </div>
          </div>
        )}
        {entries === null && error === null && (
          <p role="status" aria-busy="true" className="text-mute">
            Loading…
          </p>
        )}
        {entries !== null && entries.length === 0 && (
          <p className="text-mute">
            Nothing in progress.{' '}
            <Link to="/discover" className="underline underline-offset-4">
              Find something to watch
            </Link>
            , or look at your{' '}
            <Link to="/library" className="underline underline-offset-4">
              library
            </Link>
            .
          </p>
        )}
        {entries?.map((entry) => (
          <ContinueCard key={entry.id} entry={entry} />
        ))}
      </section>
    </div>
  );
}
