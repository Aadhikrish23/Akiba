import {
  ENTRY_STATUSES,
  LIBRARY_SORTS,
  TITLE_KINDS,
  type EntryStatus,
  type LibraryCounts,
  type LibrarySort,
  type TitleKind,
} from '@akiba/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { LibraryPoster, LibraryRow } from '../components/EntryParts';
import { GridSkeleton } from '../components/TitleResults';
import { Button, Field, Notice, Select } from '../components/ui';
import { useEntryList } from '../lib/library';
import { usePageTitle } from '../lib/page';
import { ENTRY_LABEL, KIND_LABEL } from '../lib/titles';

const SORT_LABEL: Record<LibrarySort, string> = {
  updated: 'Recently updated',
  title: 'Title',
  rating: 'Rating',
  progress: 'Progress',
  start_date: 'Date started',
};
type Tab = EntryStatus | 'favorites' | 'all';
const TABS: readonly Tab[] = ['all', ...ENTRY_STATUSES, 'favorites'];
const TAB_LABEL = (tab: Tab): string =>
  tab === 'all' ? 'All' : tab === 'favorites' ? 'Favorites' : ENTRY_LABEL[tab];

const pick = <T extends string>(options: readonly T[], value: string | null): T | undefined =>
  (options as readonly string[]).includes(value ?? '') ? (value as T) : undefined;

/**
 * The library (FR-LIB-003…005): status tabs with counts, search, filters, sort, and a poster grid
 * or a compact list. The tab, filters and the sort live in the URL; the grid/list choice is saved
 * on the account so every device remembers it.
 */
export function LibraryPage() {
  usePageTitle('Library');
  const { client, profile, updateProfile } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = pick(TABS, params.get('tab')) ?? 'all';
  const q = (params.get('q') ?? '').trim();
  const format = pick(TITLE_KINDS as readonly TitleKind[], params.get('format'));
  const sort = pick(LIBRARY_SORTS, params.get('sort')) ?? 'updated';
  // Switching is instant; saving it on the account is background work (a failure is harmless).
  const [chosenView, setChosenView] = useState<'grid' | 'list' | null>(null);
  const view = chosenView ?? profile?.libraryView ?? 'grid';

  const [draft, setDraft] = useState(q);
  useEffect(() => {
    setDraft(q);
  }, [q]);
  const [counts, setCounts] = useState<LibraryCounts | null>(null);
  useEffect(() => {
    let live = true;
    client.library
      .counts()
      .then((value) => {
        if (live) setCounts(value);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client]);

  const key = JSON.stringify({ tab, q, format, sort });
  const { state, loadMore, retry } = useEntryList(key, (cursor) => {
    const query = { q: q === '' ? undefined : q, format, sort, limit: 24, cursor };
    return tab === 'favorites'
      ? client.library.favorites(query)
      : client.library.list({ ...query, status: tab === 'all' ? undefined : tab });
  });

  const update = (changes: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    for (const [name, value] of Object.entries(changes)) {
      if (value === undefined || value === '' || (name === 'tab' && value === 'all'))
        next.delete(name);
      else next.set(name, value);
    }
    setParams(next, { replace: true });
  };
  const count = (value: Tab): number | null =>
    counts === null
      ? null
      : value === 'all'
        ? ENTRY_STATUSES.reduce((sum, status) => sum + counts[status], 0)
        : counts[value];

  return (
    <div className="grid gap-8">
      <h1 className="h-title">Library</h1>

      <nav
        aria-label="Library sections"
        className="border-rule bg-raised flex w-fit max-w-full gap-0.5 overflow-x-auto rounded-full border p-[3px]"
      >
        {TABS.map((value) => (
          <button
            key={value}
            type="button"
            aria-current={tab === value ? 'page' : undefined}
            onClick={() => {
              update({ tab: value });
            }}
            className={`min-h-10 shrink-0 cursor-pointer rounded-full px-4 py-2 text-sm whitespace-nowrap ${tab === value ? 'bg-ink text-paper font-bold' : 'text-mute hover:text-ink'}`}
          >
            {TAB_LABEL(value)}
            {count(value) !== null && (
              <span className="text-mute tabular-nums"> {count(value)}</span>
            )}
          </button>
        ))}
      </nav>

      <form
        role="search"
        aria-label="Filter the library"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          update({ q: draft.trim() });
        }}
        className="flex flex-wrap items-end gap-3"
      >
        <div className="min-w-[12rem] flex-1">
          <Field
            label="Search your library"
            type="search"
            value={draft}
            autoComplete="off"
            onChange={(event) => {
              setDraft(event.target.value);
            }}
          />
        </div>
        <Button type="submit">Search</Button>
        <Select
          label="Format"
          anyLabel="Any format"
          value={format ?? ''}
          options={TITLE_KINDS.map((value) => ({ value, label: KIND_LABEL[value] }))}
          onChange={(event) => {
            update({ format: event.target.value });
          }}
        />
        <Select
          label="Sort by"
          anyLabel="Recently updated"
          value={sort === 'updated' ? '' : sort}
          options={LIBRARY_SORTS.filter((value) => value !== 'updated').map((value) => ({
            value,
            label: SORT_LABEL[value],
          }))}
          onChange={(event) => {
            update({ sort: event.target.value });
          }}
        />
        <fieldset className="grid gap-1.5">
          <legend className="text-sm font-medium">Layout</legend>
          <div className="flex h-11 items-center gap-4">
            {(['grid', 'list'] as const).map((value) => (
              <label key={value} className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="layout"
                  value={value}
                  checked={view === value}
                  onChange={() => {
                    setChosenView(value);
                    void updateProfile({ libraryView: value }).catch(() => undefined);
                  }}
                />
                {value === 'grid' ? 'Posters' : 'List'}
              </label>
            ))}
          </div>
        </fieldset>
      </form>

      <section aria-labelledby="entries-heading" className="grid gap-4">
        <h2 id="entries-heading" className="sr-only">
          {TAB_LABEL(tab)} titles
        </h2>
        {state.phase === 'loading' && <GridSkeleton count={8} />}
        {state.phase === 'error' && (
          <div className="grid max-w-prose gap-4">
            <Notice tone="error">{state.message}</Notice>
            <div>
              <Button onClick={retry}>Try again</Button>
            </div>
          </div>
        )}
        {state.phase === 'ready' && state.items.length === 0 && (
          <p className="text-mute max-w-prose">
            {q !== '' || format !== undefined || tab !== 'all' ? (
              'Nothing in your library matches. Remove a filter to see more.'
            ) : (
              <>
                Your library is empty.{' '}
                <Link to="/discover" className="underline underline-offset-4">
                  Find something to watch
                </Link>
                .
              </>
            )}
          </p>
        )}
        {state.phase === 'ready' && state.items.length > 0 && (
          <>
            <p role="status" className="sr-only">
              {state.items.length} {state.items.length === 1 ? 'title' : 'titles'} shown
            </p>
            {view === 'list' ? (
              <ul aria-label="Library" className="list-none p-0">
                {state.items.map((entry) => (
                  <LibraryRow key={entry.id} entry={entry} />
                ))}
              </ul>
            ) : (
              <ul
                aria-label="Library"
                className="grid list-none gap-x-5 gap-y-8 p-0"
                style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 160px), 1fr))' }}
              >
                {state.items.map((entry) => (
                  <li key={entry.id}>
                    <LibraryPoster entry={entry} />
                  </li>
                ))}
              </ul>
            )}
            {state.moreError !== null && <Notice tone="error">{state.moreError}</Notice>}
            {state.hasMore && (
              <div>
                <Button onClick={loadMore} busy={state.loadingMore}>
                  {state.loadingMore ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
