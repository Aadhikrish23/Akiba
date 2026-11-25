import { ENTRY_STATUSES, mainLineOf, type EntryStatus, type FranchiseTitle } from '@akiba/shared';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { Button, Notice } from '../components/ui';
import { describeError } from '../lib/errors';
import { franchiseSummary, inSeasonOrder } from '../lib/franchise';
import { WatchChoice } from '../components/WatchChoice';
import { usePageTitle } from '../lib/page';
import { useRemote } from '../lib/remote';
import { readServices, watchChoices } from '../lib/services';
import { stockFor } from '../lib/stock';
import { ENTRY_LABEL, displayTitle, metaLine } from '../lib/titles';

/** Where the reader stands on one title of the franchise (null: not in the library). */
interface Mine {
  readonly entryId: string;
  readonly status: EntryStatus;
  readonly progress: number;
  readonly total: number | null;
}

/** A streaming service that lists the show, as AniList gives it. */
interface Service {
  readonly site: string;
  readonly url: string;
}

/** "Watch on Crunchyroll · Hulu · Netflix": the services that list the show, each opening in a new tab. */
function Services({ services }: { services: readonly Service[] }) {
  if (services.length === 0) return null;
  return (
    <p className="text-mute text-sm">
      Watch on{' '}
      {services.map((service, index) => (
        <span key={service.site + service.url}>
          {index > 0 && ' · '}
          <a
            href={service.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-ink font-bold underline underline-offset-4"
          >
            {service.site}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </span>
      ))}
    </p>
  );
}

const stateWords = (mine: Mine | undefined): { text: string; tone: string } => {
  if (mine === undefined) return { text: 'Not added', tone: 'border-rule text-mute' };
  if (mine.status === 'completed') return { text: 'Completed ✓', tone: 'border-ink text-ink' };
  if (mine.progress > 0)
    return {
      text: `${ENTRY_LABEL[mine.status]} · ${mine.progress}${mine.total === null ? '' : ` / ${mine.total}`}`,
      tone: 'border-accent text-ink',
    };
  return { text: ENTRY_LABEL[mine.status], tone: 'border-rule text-ink' };
};

/** The episodes of one season: each with where to watch it, and, if you track it, "I am here". */
function Episodes({
  title,
  services,
  myServices,
  mine,
  onSet,
  busy,
}: {
  title: FranchiseTitle;
  services: readonly Service[];
  myServices: readonly string[];
  mine: Mine | undefined;
  onSet: (episode: number) => void;
  busy: boolean;
}) {
  const { client } = useAuth();
  const { state } = useRemote(`franchise-season:${title.id}`, () => client.titles.detail(title.id));
  if (state.phase === 'loading') {
    return (
      <p role="status" aria-busy="true" className="text-mute">
        Loading the episodes…
      </p>
    );
  }
  const detail = state.phase === 'ready' ? state.value.data : null;
  const next = detail?.nextAiring ?? null;
  const count =
    mine?.total ??
    title.episodesTotal ??
    (next === null ? (mine?.progress ?? 0) : next.episode - 1);
  if (count <= 0) {
    return <p className="text-mute">No episodes have aired yet.</p>;
  }
  const watched = mine?.progress ?? 0;
  const aired = title.episodesAired;
  return (
    <div className="grid gap-3">
      {state.phase === 'error' && (
        <Notice>
          The episode links could not be loaded; the show&rsquo;s page is used instead.
        </Notice>
      )}
      <p className="text-mute text-sm">
        {mine === undefined
          ? 'Add the season to track what you have watched.'
          : 'Mark the one you are up to and everything before it counts as watched.'}
      </p>
      <ol
        aria-label={`Episodes of ${displayTitle(title)}`}
        className="m-0 grid list-none gap-x-6 gap-y-1 p-0 min-[760px]:grid-cols-2"
      >
        {Array.from({ length: count }, (_, index) => index + 1).map((episode) => {
          const choices = watchChoices(
            detail?.streamingLinks.length ? detail.streamingLinks : services,
            myServices,
            detail?.crunchyrollEpisodes ?? {},
            episode,
          );
          const seen = episode <= watched;
          // A running season lists every episode it will have, but only the aired ones can be logged
          // or watched.
          const unaired = aired !== null && episode > aired && episode > watched;
          return (
            <li
              key={episode}
              className="border-rule flex items-center gap-3 border-b py-2"
              data-episode={episode}
            >
              <span className="font-display w-20 text-lg font-extrabold uppercase">
                Ep {episode}
              </span>
              <span
                className={`text-sm ${seen ? 'text-ink font-bold' : !unaired && episode === watched + 1 && mine !== undefined ? 'text-accent font-bold' : 'text-mute'}`}
              >
                {seen
                  ? 'Watched ✓'
                  : unaired
                    ? 'Not aired yet'
                    : episode === watched + 1 && mine !== undefined
                      ? 'Next'
                      : ''}
              </span>
              <span className="ml-auto flex items-center gap-2">
                {!unaired && mine !== undefined && (
                  <button
                    type="button"
                    disabled={busy}
                    aria-pressed={seen}
                    aria-label={
                      episode === watched
                        ? `Watched up to episode ${episode}: undo`
                        : `Mark up to episode ${episode} as watched`
                    }
                    onClick={() => {
                      onSet(episode === watched ? episode - 1 : episode);
                    }}
                    className="border-rule hover:border-ink min-h-9 cursor-pointer rounded-full border-[1.5px] px-3 text-sm font-bold disabled:opacity-50"
                  >
                    {episode === watched ? 'Undo' : 'Up to here'}
                  </button>
                )}
                {!unaired && <WatchChoice choices={choices} />}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * A show's page (doc 08 §3): all its seasons with their episodes, the movies, specials and
 * spin-offs, and what you can do with each: add it to the library, mark where you are, watch an
 * episode on Crunchyroll. Opened from the show's tile in Discover and the Library.
 */
export function FranchisePage() {
  const { franchiseId = '' } = useParams();
  const { client } = useAuth();
  const { state, retry } = useRemote(`franchise:${franchiseId}`, () =>
    client.explore.franchise(franchiseId),
  );
  const [mine, setMine] = useState<Record<string, Mine>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [addAs, setAddAs] = useState<EntryStatus>('planned');
  const [busy, setBusy] = useState(false);
  const [myServices] = useState(readServices);
  const [problem, setProblem] = useState<string | null>(null);

  const franchise = state.phase === 'ready' ? state.value.data : null;
  useEffect(() => {
    if (franchise === null) return;
    const next: Record<string, Mine> = {};
    for (const title of franchise.titles) {
      if (title.libraryEntryId === null || title.libraryStatus === null) continue;
      next[title.id] = {
        entryId: title.libraryEntryId,
        status: title.libraryStatus,
        progress: title.entry?.progress ?? 0,
        total: title.entry?.total ?? title.episodesTotal,
      };
    }
    setMine(next);
  }, [franchise]);

  // Titles stored before streaming links were kept have none: opening a title's detail fetches them
  // once, so the seasons get their services without the reader opening each one.
  const [fetched, setFetched] = useState<Record<string, readonly Service[]>>({});
  useEffect(() => {
    if (franchise === null) return;
    let live = true;
    const missing = franchise.titles
      .filter((title) => title.kind === 'tv' && title.streamingLinks.length === 0)
      .slice(0, 12);
    void (async () => {
      for (const title of missing) {
        try {
          const detail = await client.titles.detail(title.id);
          if (!live) return;
          setFetched((current) => ({ ...current, [title.id]: detail.data.streamingLinks }));
        } catch {
          // The season simply shows no services.
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [franchise, client]);
  const servicesOf = (title: FranchiseTitle): readonly Service[] =>
    title.streamingLinks.length > 0 ? title.streamingLinks : (fetched[title.id] ?? []);

  const root = franchise?.titles[0];
  const name = root === undefined ? 'Franchise' : displayTitle(root);
  usePageTitle(name);

  const split = useMemo(() => {
    if (franchise === null)
      return { seasons: [] as FranchiseTitle[], others: [] as FranchiseTitle[] };
    const edges = franchise.relations.map((relation) => ({
      from: relation.fromTitleId,
      to: relation.toTitleId,
      type: relation.relationType,
    }));
    const line = mainLineOf(franchise.titles[0]?.id ?? '', edges);
    const seasons = inSeasonOrder(
      franchise.titles.filter((title) => line.has(title.id) && title.kind === 'tv'),
      edges,
    );
    return { seasons, others: franchise.titles.filter((title) => !seasons.includes(title)) };
  }, [franchise]);

  if (state.phase === 'loading') {
    return (
      <p role="status" aria-busy="true" className="text-mute">
        Loading…
      </p>
    );
  }
  if (state.phase !== 'ready' || franchise === null || root === undefined) {
    return (
      <div className="grid max-w-prose gap-3">
        {state.phase === 'missing' && <h1 className="h-title">Franchise not found</h1>}
        <Notice tone="error">
          {state.phase === 'missing'
            ? 'This franchise does not exist, or is not available to you.'
            : state.phase === 'error'
              ? state.message
              : ''}
        </Notice>
        {state.phase === 'error' && (
          <div>
            <Button onClick={retry}>Try again</Button>
          </div>
        )}
      </div>
    );
  }

  const { seasons, others } = split;
  const summary = franchiseSummary({
    id: franchise.id,
    size: franchise.titles.length,
    seasons: seasons.length,
    titleRomaji: root.titleRomaji,
    titleEnglish: root.titleEnglish,
    titleNative: root.titleNative,
    covers: [],
  });
  const totalEpisodes = seasons.reduce((sum, title) => sum + (title.episodesTotal ?? 0), 0);
  const years = franchise.titles
    .map((title) => title.startDate?.slice(0, 4))
    .filter((year): year is string => year !== undefined);
  const range =
    years.length === 0
      ? ''
      : years[0] === years.at(-1)
        ? years[0]!
        : `${years[0]} – ${years.at(-1)}`;
  const inLibrary = seasons.filter((title) => mine[title.id] !== undefined);
  const watchedCount = seasons.reduce((sum, title) => sum + (mine[title.id]?.progress ?? 0), 0);
  const current = seasons.find((title) => {
    const entry = mine[title.id];
    return (
      entry !== undefined &&
      entry.status !== 'completed' &&
      (entry.total === null || entry.progress < entry.total) &&
      (title.episodesAired === null || entry.progress < title.episodesAired)
    );
  });
  const currentMine = current === undefined ? undefined : mine[current.id];

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (caught) {
      setProblem(describeError(caught).message);
    } finally {
      setBusy(false);
    }
  };
  const add = (title: FranchiseTitle, status: EntryStatus) =>
    run(async () => {
      const entry = await client.library.add(title.id, status);
      setMine((current) => ({
        ...current,
        [title.id]: {
          entryId: entry.id,
          status: entry.status,
          progress: entry.progress,
          total: entry.effectiveTotal,
        },
      }));
    });
  const addAll = () =>
    run(async () => {
      for (const title of seasons) {
        if (mine[title.id] !== undefined) continue;
        const entry = await client.library.add(title.id, addAs);
        setMine((current) => ({
          ...current,
          [title.id]: {
            entryId: entry.id,
            status: entry.status,
            progress: entry.progress,
            total: entry.effectiveTotal,
          },
        }));
      }
    });
  const setStatus = (title: FranchiseTitle, entry: Mine, status: EntryStatus) =>
    run(async () => {
      const updated = await client.library.update(entry.entryId, { status });
      setMine((current) => ({
        ...current,
        [title.id]: {
          entryId: entry.entryId,
          status: updated.status,
          progress: updated.progress,
          total: updated.effectiveTotal,
        },
      }));
    });
  const setProgress = (title: FranchiseTitle, entry: Mine, value: number) =>
    run(async () => {
      const result = await client.library.progress(entry.entryId, { set: value });
      setMine((current) => ({
        ...current,
        [title.id]: {
          entryId: entry.entryId,
          status: result.data.status,
          progress: result.data.progress,
          total: result.data.effectiveTotal,
        },
      }));
    });

  const stack = seasons.length > 0 ? seasons : franchise.titles;
  return (
    <div className="grid gap-8">
      <header className="grid items-end gap-x-8 gap-y-5 min-[700px]:grid-cols-[250px_minmax(0,1fr)]">
        <div
          className="relative mx-auto mt-3 aspect-[2/3] w-[150px] min-[700px]:mx-0 min-[700px]:ml-8 min-[700px]:w-[calc(100%-4rem)]"
          aria-hidden="true"
        >
          {stack.slice(0, 3).map((title, index) => (
            <span key={title.id} className="absolute inset-0">
              {title.coverUrl === null ? (
                <span
                  className="border-paper block size-full rounded-md border-2"
                  style={{ background: stockFor(title) }}
                />
              ) : (
                <img
                  src={title.coverUrl}
                  alt=""
                  className="border-paper size-full rounded-md border-2 object-cover shadow-xl"
                  style={{
                    transform: [
                      'translate(-12%, 2%) rotate(-8deg)',
                      'translate(12%, 2%) rotate(8deg)',
                      'none',
                    ][index],
                    filter:
                      index === 0 ? 'brightness(.65)' : index === 1 ? 'brightness(.8)' : 'none',
                  }}
                />
              )}
            </span>
          ))}
        </div>
        <div className="grid gap-3">
          <p className="text-accent text-xs font-bold tracking-[0.16em] uppercase">Franchise</p>
          <h1 className="h-page">{name}</h1>
          <p className="text-mute flex flex-wrap gap-x-6 gap-y-1">
            <span>{summary}</span>
            {totalEpisodes > 0 && <span>{totalEpisodes} episodes in the seasons</span>}
            {range !== '' && <span>{range}</span>}
          </p>
          {inLibrary.length === 0 && seasons.length > 0 ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" busy={busy} onClick={() => void addAll()}>
                + Add all {seasons.length} {seasons.length === 1 ? 'season' : 'seasons'}
              </Button>
              <label className="sr-only" htmlFor="add-as">
                Add as
              </label>
              <select
                id="add-as"
                value={addAs}
                onChange={(event) => {
                  setAddAs(event.target.value as EntryStatus);
                }}
                className="border-rule bg-raised text-ink h-11 rounded-full border px-4"
              >
                {ENTRY_STATUSES.filter(
                  (status) => status === 'planned' || status === 'watching',
                ).map((status) => (
                  <option key={status} value={status}>
                    as {ENTRY_LABEL[status]}
                  </option>
                ))}
              </select>
              <span className="text-mute text-sm">or add the seasons you want below</span>
            </div>
          ) : (
            <p role="status" className="max-w-xl">
              <b className="font-display text-3xl font-extrabold">{inLibrary.length}</b> of{' '}
              {seasons.length} seasons in your library ·{' '}
              <b className="font-display text-3xl font-extrabold">{watchedCount}</b> of{' '}
              {totalEpisodes} episodes watched
            </p>
          )}
        </div>
      </header>

      {problem !== null && <Notice tone="error">{problem}</Notice>}

      {current !== undefined && currentMine !== undefined && (
        <section aria-label="Continue watching">
          <div
            className="grid grid-cols-[72px_minmax(0,1fr)_auto] items-stretch gap-0 rounded-xl text-[var(--stub-ink)] min-[700px]:grid-cols-[96px_minmax(0,1fr)_auto]"
            style={{ background: stockFor(current) }}
          >
            {current.coverUrl === null ? (
              <span />
            ) : (
              <img src={current.coverUrl} alt="" className="size-full rounded-l-xl object-cover" />
            )}
            <div className="grid content-between gap-2 p-4 min-[700px]:p-5">
              <p className="text-xs font-extrabold tracking-[0.16em] uppercase opacity-75">
                Continue · {displayTitle(current)}
              </p>
              <h2 className="font-display text-3xl leading-none font-black uppercase min-[700px]:text-4xl">
                Episode {currentMine.progress + 1} is next
              </h2>
              <div>
                <WatchChoice
                  choices={watchChoices(
                    servicesOf(current),
                    myServices,
                    {},
                    currentMine.progress + 1,
                  )}
                  className="!border-[var(--stub-ink)]"
                />
              </div>
            </div>
            <div className="grid min-w-[110px] place-items-center gap-2 border-l-[2.5px] border-dashed border-[color-mix(in_oklab,var(--stub-ink)_40%,transparent)] p-3">
              <p className="font-display text-5xl leading-none font-black">
                {currentMine.progress}
                <small className="text-xl font-medium opacity-65">
                  {currentMine.total === null ? '' : ` / ${currentMine.total}`}
                </small>
              </p>
              <button
                type="button"
                disabled={busy}
                aria-label={`+1 episode of ${displayTitle(current)}`}
                onClick={() => void setProgress(current, currentMine, currentMine.progress + 1)}
                className="bg-ink text-accent font-display size-16 cursor-pointer rounded-full text-2xl font-black disabled:opacity-50"
              >
                +1
              </button>
            </div>
          </div>
        </section>
      )}

      <section aria-labelledby="seasons-heading" className="grid gap-3">
        <h2 id="seasons-heading" className="h-section">
          Seasons{' '}
          <small className="text-mute font-sans text-sm font-normal tracking-normal normal-case">
            open one for its episodes
          </small>
        </h2>
        {seasons.map((title, index) => (
          <TitleBlock
            key={title.id}
            title={title}
            services={servicesOf(title)}
            myServices={myServices}
            season={index + 1}
            mine={mine[title.id]}
            open={open === title.id}
            busy={busy}
            addAs={addAs}
            onToggle={() => {
              setOpen((value) => (value === title.id ? null : title.id));
            }}
            onAdd={(status) => void add(title, status)}
            onStatus={(status) => {
              const entry = mine[title.id];
              if (entry !== undefined) void setStatus(title, entry, status);
            }}
            onSet={(value) => {
              const entry = mine[title.id];
              if (entry !== undefined) void setProgress(title, entry, value);
            }}
          />
        ))}
      </section>

      {others.length > 0 && (
        <section aria-labelledby="others-heading" className="grid gap-3">
          <h2 id="others-heading" className="h-section">
            Movies, specials and spin-offs{' '}
            <small className="text-mute font-sans text-sm font-normal tracking-normal normal-case">
              {others.length} titles
            </small>
          </h2>
          {others.map((title) => (
            <TitleBlock
              key={title.id}
              title={title}
              services={servicesOf(title)}
              myServices={myServices}
              season={null}
              mine={mine[title.id]}
              open={open === title.id}
              busy={busy}
              addAs={addAs}
              onToggle={() => {
                setOpen((value) => (value === title.id ? null : title.id));
              }}
              onAdd={(status) => void add(title, status)}
              onStatus={(status) => {
                const entry = mine[title.id];
                if (entry !== undefined) void setStatus(title, entry, status);
              }}
              onSet={(value) => {
                const entry = mine[title.id];
                if (entry !== undefined) void setProgress(title, entry, value);
              }}
            />
          ))}
        </section>
      )}
    </div>
  );
}

/** One title as a row: cover, name and facts, where you stand, and what you can do; it opens to its episodes. */
function TitleBlock({
  title,
  services,
  myServices,
  season,
  mine,
  open,
  busy,
  addAs,
  onToggle,
  onAdd,
  onStatus,
  onSet,
}: {
  title: FranchiseTitle;
  services: readonly Service[];
  myServices: readonly string[];
  season: number | null;
  mine: Mine | undefined;
  open: boolean;
  busy: boolean;
  addAs: EntryStatus;
  onToggle: () => void;
  onAdd: (status: EntryStatus) => void;
  onStatus: (status: EntryStatus) => void;
  onSet: (value: number) => void;
}) {
  const state = stateWords(mine);
  const name = displayTitle(title);
  const panel = `episodes-${title.id}`;
  return (
    <article className="grid gap-0">
      <div
        className={`border-rule bg-raised grid grid-cols-[52px_minmax(0,1fr)] items-center gap-x-4 gap-y-3 border-[1.5px] p-3 min-[700px]:grid-cols-[58px_minmax(0,1fr)_auto] ${open ? 'rounded-t-xl' : 'rounded-xl'}`}
      >
        {title.coverUrl === null ? (
          <span
            aria-hidden="true"
            className="aspect-[2/3] rounded-sm"
            style={{ background: stockFor(title) }}
          />
        ) : (
          <img
            src={title.coverUrl}
            alt=""
            loading="lazy"
            className="aspect-[2/3] rounded-sm object-cover"
          />
        )}
        <div className="min-w-0">
          {season !== null && (
            <p className="text-mute text-xs font-bold tracking-[0.14em] uppercase">
              Season {season}
            </p>
          )}
          <h3 className="h-item">
            <Link to={`/title/${title.id}`} className="underline-offset-4 hover:underline">
              {name}
            </Link>
          </h3>
          <p className="text-mute text-sm">
            {metaLine(title)}
            {title.startDate !== null && ` · ${title.startDate}`}
          </p>
          <Services services={services} />
          {mine !== undefined && mine.total !== null && mine.total > 0 && (
            <div
              role="progressbar"
              aria-label={`Progress in ${name}`}
              aria-valuemin={0}
              aria-valuemax={mine.total}
              aria-valuenow={mine.progress}
              className="bg-raised-2 mt-2 h-1.5 max-w-64 overflow-hidden rounded-sm"
            >
              <div
                className="bg-accent h-full"
                style={{ width: `${Math.min(100, (mine.progress / mine.total) * 100)}%` }}
              />
            </div>
          )}
        </div>
        <div className="col-span-2 flex flex-wrap items-center justify-between gap-2 min-[700px]:col-span-1 min-[700px]:justify-end">
          <span
            className={`rounded-full border-[1.5px] px-3 py-1 text-sm font-bold whitespace-nowrap ${state.tone}`}
          >
            {state.text}
          </span>
          {mine !== undefined && (
            <select
              aria-label={`Status of ${name}`}
              value={mine.status}
              disabled={busy}
              onChange={(event) => {
                onStatus(event.target.value as EntryStatus);
              }}
              className="border-rule bg-raised text-ink h-10 rounded-full border-[1.5px] px-3 text-sm font-bold disabled:opacity-50"
            >
              {ENTRY_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {ENTRY_LABEL[value]}
                </option>
              ))}
            </select>
          )}
          {mine === undefined && (
            <Button
              busy={busy}
              onClick={() => {
                onAdd(addAs);
              }}
              aria-label={`Add ${name} as ${ENTRY_LABEL[addAs]}`}
            >
              + Add
            </Button>
          )}
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panel}
            aria-label={`Episodes of ${name}`}
            onClick={onToggle}
            className="text-mute hover:text-ink grid size-10 cursor-pointer place-items-center rounded-full"
          >
            <svg
              viewBox="0 0 24 24"
              aria-hidden="true"
              className={`size-6 fill-none stroke-current transition-transform ${open ? 'rotate-180' : ''}`}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        </div>
      </div>
      <div
        id={panel}
        hidden={!open}
        className="border-rule bg-raised/50 rounded-b-xl border-[1.5px] border-t-0 p-4"
      >
        {open && (
          <Episodes
            title={title}
            services={services}
            myServices={myServices}
            mine={mine}
            busy={busy}
            onSet={onSet}
          />
        )}
      </div>
    </article>
  );
}
