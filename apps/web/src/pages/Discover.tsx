import {
  TITLE_KINDS,
  TITLE_SORTS,
  TITLE_STATUSES,
  type TitleKind,
  type TitleSort,
  type TitleStatus,
} from '@akiba/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { TitleResults } from '../components/TitleResults';
import { Button, Field, Select } from '../components/ui';
import { usePageTitle } from '../lib/page';
import { KIND_LABEL, STATUS_LABEL, useTitleList } from '../lib/titles';

const SORT_LABEL: Record<TitleSort, string> = {
  popularity: 'Most popular',
  score: 'Highest rated',
  start_date: 'Newest',
};

const asKind = (value: string | null): TitleKind | undefined =>
  (TITLE_KINDS as readonly string[]).includes(value ?? '') ? (value as TitleKind) : undefined;
const asStatus = (value: string | null): TitleStatus | undefined =>
  (TITLE_STATUSES as readonly string[]).includes(value ?? '') ? (value as TitleStatus) : undefined;
const asSort = (value: string | null): TitleSort | undefined =>
  (TITLE_SORTS as readonly string[]).includes(value ?? '') ? (value as TitleSort) : undefined;

/**
 * Discover (FR-DISC-001, -002, -006): search by name, or browse with filters. The whole state is in
 * the URL, so the back button, a reload and a copied link all show the same list.
 */
export function DiscoverPage() {
  usePageTitle('Discover');
  const { client } = useAuth();
  const [params, setParams] = useSearchParams();
  const q = (params.get('q') ?? '').trim();
  const format = asKind(params.get('format'));
  const status = asStatus(params.get('status'));
  const sort = asSort(params.get('sort'));
  const genre = params.get('genre') ?? '';

  const [draft, setDraft] = useState(q);
  useEffect(() => {
    setDraft(q);
  }, [q]);
  const [genres, setGenres] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    client.titles
      .genres()
      .then((names) => {
        if (live) setGenres(names);
      })
      .catch(() => {
        // The filter simply offers no genres; the list below reports real problems.
      });
    return () => {
      live = false;
    };
  }, [client]);

  const searching = q !== '';
  const key = JSON.stringify({ q, format, status, sort, genre });
  const { state, loadMore, retry } = useTitleList(key, (cursor) =>
    searching
      ? client.titles.search({ q, format, limit: 24, cursor })
      : client.titles.browse({
          format,
          status,
          sort,
          genre: genre === '' ? undefined : genre,
          limit: 24,
          cursor,
        }),
  );

  const update = (changes: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    for (const [name, value] of Object.entries(changes)) {
      if (value === undefined || value === '') next.delete(name);
      else next.set(name, value);
    }
    setParams(next, { replace: true });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    update({ q: draft.trim() });
  };

  return (
    <div className="grid gap-8">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h1 className="h-title">Discover</h1>
        <Link to="/discover/season" className="text-sm underline underline-offset-4">
          Seasonal chart
        </Link>
      </div>

      <form
        role="search"
        aria-label="Find titles"
        onSubmit={submit}
        className="grid max-w-5xl gap-4"
      >
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[14rem] flex-1">
            <Field
              label="Search by name"
              type="search"
              name="q"
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
              }}
              autoComplete="off"
            />
          </div>
          <Button type="submit" variant="primary">
            Search
          </Button>
          {searching && (
            <Button
              type="button"
              onClick={() => {
                update({ q: undefined });
              }}
            >
              Clear search
            </Button>
          )}
        </div>
        <div className="grid gap-3 min-[560px]:grid-cols-2 min-[880px]:grid-cols-4">
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
            label="Status"
            anyLabel="Any status"
            value={status ?? ''}
            disabled={searching}
            options={TITLE_STATUSES.map((value) => ({ value, label: STATUS_LABEL[value] }))}
            onChange={(event) => {
              update({ status: event.target.value });
            }}
          />
          <Select
            label="Genre"
            anyLabel="Any genre"
            value={genre}
            disabled={searching}
            options={genres.map((name) => ({ value: name, label: name }))}
            onChange={(event) => {
              update({ genre: event.target.value });
            }}
          />
          <Select
            label="Sort by"
            anyLabel="Most popular"
            value={sort ?? ''}
            disabled={searching}
            options={TITLE_SORTS.filter((value) => value !== 'popularity').map((value) => ({
              value,
              label: SORT_LABEL[value],
            }))}
            onChange={(event) => {
              update({ sort: event.target.value });
            }}
          />
        </div>
        {searching && (
          <p className="text-mute text-sm">
            Status, genre and sort apply when browsing. Clear the search to use them.
          </p>
        )}
      </form>

      <section aria-labelledby="results-heading" className="grid gap-4">
        <h2 id="results-heading" className="h-section">
          {searching ? `Results for “${q}”` : 'Browse'}
        </h2>
        <TitleResults
          state={state}
          label={searching ? 'Search results' : 'Titles'}
          onRetry={retry}
          onLoadMore={loadMore}
          empty={
            <p>
              {searching
                ? `Nothing matches “${q}”. Try a different spelling, or the original title.`
                : 'No titles match these filters. Remove one to see more.'}
            </p>
          }
        />
      </section>
    </div>
  );
}
