import {
  ENTRY_STATUSES,
  LIBRARY_SORTS,
  TITLE_KINDS,
  type EntryStatus,
  type LibraryCounts,
  type LibraryEntry,
  type LibrarySort,
  type TitleKind,
} from '@akiba/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { LibraryPoster, LibraryRow } from '../components/EntryParts';
import { FranchiseTile } from '../components/FranchiseTile';
import { GridSkeleton } from '../components/TitleResults';
import { Button, Field, Notice, Select } from '../components/ui';
import { groupByFranchise, type Grouped } from '../lib/franchise';
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

/** The seasons of one show you have in your library as one tile: how many, how many finished, how far in each. */
function EntryTile({ group }: { group: Extract<Grouped<LibraryEntry>, { kind: 'banner' }> }) {
  const done = group.items.filter((entry) => entry.status === 'completed').length;
  // One season of the show: say where you are in it, as a poster would.
  const only = group.items.length === 1 ? group.items[0] : undefined;
  return (
    <FranchiseTile
      franchise={group.franchise}
      covers={group.items.map((entry) => entry.title)}
      standing={
        only === undefined
          ? `${group.items.length} in your library${done > 0 ? `, ${done} completed` : ''}`
          : `${ENTRY_LABEL[only.status]} · ${only.progress} / ${only.effectiveTotal ?? only.episodesAired ?? '?'}`
      }
      progress={group.items.map((entry) =>
        entry.status === 'completed'
          ? 1
          : entry.effectiveTotal === null
            ? 0
            : Math.min(1, entry.progress / entry.effectiveTotal),
      )}
    />
  );
}

const pick = <T extends string>(options: readonly T[], value: string | null): T | undefined =>
  (options as readonly string[]).includes(value ?? '') ? (value as T) : undefined;

/** How long typing must pause before the library search runs. */
const SEARCH_DELAY_MS = 300;

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
  // A change to the address (back, a link) shows in the box. What you are typing is left alone: the
  // search trims it, so a trailing space must not be taken away mid-word.
  useEffect(() => {
    setDraft((current) => (current.trim() === q ? current : q));
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
  // Search as you type: once typing pauses, the box is the search.
  useEffect(() => {
    const wanted = draft.trim();
    if (wanted === q) return;
    const timer = setTimeout(() => {
      update({ q: wanted });
    }, SEARCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
    // `update` is rebuilt on every render; the timer only needs to restart when the text changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, q]);
  // Posters: every title of a franchise is its tile, even one season, so the grid looks the same
  // for all of them. The compact list keeps a lone season as the entry it is, with its +1.
  const tilesOf = (minItems: number) =>
    state.phase === 'ready'
      ? groupByFranchise(
          state.items,
          (entry) => entry.title.franchise,
          (entry) => entry.id,
          minItems,
        )
      : [];
  const groups = tilesOf(view === 'list' ? 2 : 1);
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
                {groups.map((group) =>
                  group.kind === 'one' ? (
                    <LibraryRow key={group.key} entry={group.item} />
                  ) : (
                    <li key={group.key} className="border-rule border-b py-3">
                      <div className="max-w-60">
                        <EntryTile group={group} />
                      </div>
                    </li>
                  ),
                )}
              </ul>
            ) : (
              <ul
                aria-label="Library"
                className="grid list-none gap-x-4 gap-y-10 min-[560px]:gap-x-7 p-0"
                style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 160px), 1fr))' }}
              >
                {groups.map((group) =>
                  group.kind === 'one' ? (
                    <li key={group.key}>
                      <LibraryPoster entry={group.item} />
                    </li>
                  ) : (
                    <li key={group.key}>
                      <EntryTile group={group} />
                    </li>
                  ),
                )}
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
