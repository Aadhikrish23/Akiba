import type { LibraryEntry, Notification } from '@akiba/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { Ticket, stockFor } from '../components/Ticket';
import { Button, Notice } from '../components/ui';
import { describeError } from '../lib/errors';
import { usePageTitle } from '../lib/page';
import { displayTitle } from '../lib/titles';

/** "2h ago", "yesterday", or a short date: enough for a list that is read at a glance. */
function timeAgo(iso: string, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** Home: what to watch next. "Continue watching" as tickets with +1 (doc 08 key flow 1). */
export function HomePage() {
  usePageTitle('Home');
  const { state, client } = useAuth();
  const name = state.status === 'signed-in' ? (state.user.displayName ?? 'there') : 'there';
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [aired, setAired] = useState<Notification[]>([]);

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

  // The side list is a convenience: if it cannot load, Home simply does without it.
  useEffect(() => {
    let live = true;
    client.inbox
      .list({ unread: true, limit: 4 })
      .then((response) => {
        if (live) setAired(response.data);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client]);

  const [first, ...rest] = entries ?? [];

  return (
    <div className="grid gap-8 min-[1180px]:grid-cols-[minmax(0,1fr)_340px] min-[1180px]:gap-12">
      <div className="grid min-w-0 content-start gap-8">
        <div className="grid gap-3">
          <h1 className="h-page">
            Welcome, <em>{name}</em>
          </h1>
          {entries !== null && entries.length > 0 && (
            <p className="text-mute max-w-[54ch] text-lg">
              {entries.length === 1
                ? 'One show is waiting for its next stamp.'
                : `${entries.length} shows are waiting for their next stamp.`}
            </p>
          )}
        </div>
        <section aria-labelledby="continue-heading" className="grid gap-4">
          <h2 id="continue-heading" className="h-section">
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
          {first !== undefined && <Ticket key={first.id} entry={first} size="hero" />}
          {rest.length > 0 && (
            <div
              className="grid gap-x-6 gap-y-8"
              style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 340px), 1fr))' }}
            >
              {rest.map((entry) => (
                <Ticket key={entry.id} entry={entry} size="sm" />
              ))}
            </div>
          )}
        </section>
      </div>

      {aired.length > 0 && (
        <aside aria-labelledby="aired-heading" className="grid content-start gap-4">
          <h2 id="aired-heading" className="h-section flex items-baseline gap-3">
            Aired for you
            <Link
              to="/inbox"
              className="text-mute ml-auto font-sans text-sm font-medium tracking-normal normal-case underline underline-offset-4"
            >
              Inbox
            </Link>
          </h2>
          <ul className="grid list-none gap-2.5 p-0">
            {aired.map((note) => (
              <li
                key={note.id}
                className="border-rule bg-raised relative grid grid-cols-[44px_1fr_auto] items-center gap-3 rounded-md border p-2 pr-3"
              >
                {note.title.coverUrl === null ? (
                  <span
                    aria-hidden="true"
                    className="h-[62px] w-11 rounded-sm"
                    style={{ background: stockFor(note.title.id) }}
                  />
                ) : (
                  <img
                    src={note.title.coverUrl}
                    alt=""
                    loading="lazy"
                    className="h-[62px] w-11 rounded-sm object-cover"
                  />
                )}
                <div className="min-w-0">
                  <Link
                    to={`/title/${note.title.id}`}
                    className="block text-[0.9375rem] leading-tight font-bold after:absolute after:inset-0"
                  >
                    {displayTitle(note.title)}
                  </Link>
                  <span className="text-mute text-sm">
                    Episode {note.episode.number} · {timeAgo(note.episode.airsAt)}
                  </span>
                </div>
                <span className="bg-accent size-2.5 rounded-full" aria-hidden="true" />
              </li>
            ))}
          </ul>
        </aside>
      )}
    </div>
  );
}
