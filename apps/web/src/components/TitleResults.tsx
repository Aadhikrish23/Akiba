import { Button, Notice } from './ui';
import { FranchiseBanner, FranchiseTitles } from './FranchiseBanner';
import { PosterCard, PosterGrid } from './PosterCard';
import { groupByFranchise } from '../lib/franchise';
import type { ListState } from '../lib/titles';

/** Loading skeleton that matches the grid it will become (doc 08 §5: no spinners over content). */
export function GridSkeleton({ count = 12 }: { count?: number }) {
  return (
    <div
      aria-busy="true"
      role="status"
      aria-label="Loading titles"
      className="grid gap-x-5 gap-y-8"
      style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}
    >
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="grid gap-2" aria-hidden="true">
          <div className="bg-rule/50 aspect-[2/3] rounded-sm" />
          <div className="bg-rule/50 h-4 w-4/5 rounded-sm" />
          <div className="bg-rule/50 h-3 w-3/5 rounded-sm" />
        </div>
      ))}
    </div>
  );
}

/**
 * One list of titles in all its states: loading, error with retry, empty, results with a stale
 * label and "Load more". `empty` is one sentence and one action (doc 08 §5).
 */
export function TitleResults({
  state,
  label,
  empty,
  onRetry,
  onLoadMore,
  groupSeasons = false,
}: {
  state: ListState;
  label: string;
  empty: React.ReactNode;
  onRetry: () => void;
  onLoadMore: () => void;
  /** Show the seasons of one show as one banner (search and browse). */
  groupSeasons?: boolean;
}) {
  if (state.phase === 'loading') return <GridSkeleton />;
  if (state.phase === 'error') {
    return (
      <div className="grid max-w-prose gap-4">
        <Notice tone="error">{state.message}</Notice>
        <div>
          <Button onClick={onRetry}>Try again</Button>
        </div>
      </div>
    );
  }
  return (
    <div className="grid gap-6">
      {state.meta.stale && (
        <Notice>
          Showing saved results: the anime catalog could not be reached just now. They may be out of
          date.
        </Notice>
      )}
      {state.items.length === 0 ? (
        <div className="text-mute max-w-prose">{empty}</div>
      ) : (
        <>
          <p role="status" className="sr-only">
            {state.items.length} {state.items.length === 1 ? 'title' : 'titles'} shown
          </p>
          <PosterGrid label={label}>
            {(groupSeasons
              ? groupByFranchise(
                  state.items,
                  (item) => item.franchise,
                  (item) => item.id,
                )
              : state.items.map((item) => ({ kind: 'one' as const, key: item.id, item }))
            ).map((group) =>
              group.kind === 'one' ? (
                <li key={group.key}>
                  <PosterCard title={group.item} />
                </li>
              ) : (
                <li key={group.key} className="col-span-full">
                  <FranchiseBanner
                    franchise={group.franchise}
                    covers={group.items.map((item) => item.coverUrl)}
                    standing={
                      group.items.some((item) => item.libraryStatus !== null)
                        ? `${group.items.filter((item) => item.libraryStatus !== null).length} in your library`
                        : undefined
                    }
                  >
                    <FranchiseTitles franchiseId={group.franchise.id} />
                  </FranchiseBanner>
                </li>
              ),
            )}
          </PosterGrid>
        </>
      )}
      {state.moreError !== null && <Notice tone="error">{state.moreError}</Notice>}
      {state.hasMore && (
        <div>
          <Button onClick={onLoadMore} busy={state.loadingMore}>
            {state.loadingMore ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  );
}
