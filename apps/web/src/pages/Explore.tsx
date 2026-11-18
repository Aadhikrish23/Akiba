import type { CharacterRole, Franchise, FranchiseTitle } from '@akiba/shared';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { PosterCard, PosterGrid } from '../components/PosterCard';
import { TitleResults } from '../components/TitleResults';
import { Button, Notice } from '../components/ui';
import { usePageTitle } from '../lib/page';
import { useRemote, type Remote } from '../lib/remote';
import { ENTRY_LABEL, RELATION_LABEL, displayTitle, metaLine, useTitleList } from '../lib/titles';

/** Franchise, studio and character pages (FR-EXP-001…004; doc 08 §4). */

export const ROLE_LABEL: Readonly<Record<CharacterRole, string>> = {
  main: 'Main character',
  supporting: 'Supporting character',
  background: 'Background character',
};

function PageSkeleton({ label }: { label: string }) {
  return (
    <div aria-busy="true" role="status" aria-label={label} className="grid max-w-4xl gap-4">
      <div className="bg-rule/50 h-8 w-1/2 rounded-sm" />
      <div className="bg-rule/50 h-4 w-1/3 rounded-sm" />
      <div className="bg-rule/50 h-40 rounded-sm" />
    </div>
  );
}

/** What every page of this kind shows when it cannot show itself. */
function Unavailable<T>({
  state,
  what,
  retry,
  children,
}: {
  state: Remote<T>;
  what: string;
  retry: () => void;
  children: (value: T) => ReactNode;
}) {
  if (state.phase === 'loading') return <PageSkeleton label={`Loading ${what}`} />;
  if (state.phase === 'missing') {
    return (
      <div className="grid max-w-prose gap-3">
        <h1 className="font-serif text-2xl font-semibold">
          {what.charAt(0).toUpperCase() + what.slice(1)} not found
        </h1>
        <p className="text-mute">This {what} does not exist, or it is not available.</p>
        <p>
          <Link to="/discover" className="underline underline-offset-4">
            Back to Discover
          </Link>
        </p>
      </div>
    );
  }
  if (state.phase === 'error') {
    return (
      <div className="grid max-w-prose gap-4">
        <Notice tone="error">{state.message}</Notice>
        <div>
          <Button onClick={retry}>Try again</Button>
        </div>
      </div>
    );
  }
  return <>{children(state.value)}</>;
}

// ── Franchise ─────────────────────────────────────────────────────────────────

/** "After this: Season 2 · Spin-offs: OVA" for one title, from the relations that start at it. */
function relationLines(franchise: Franchise, title: FranchiseTitle): [string, string][] {
  const byId = new Map(franchise.titles.map((item) => [item.id, item]));
  const groups = new Map<string, string[]>();
  for (const relation of franchise.relations) {
    if (relation.fromTitleId !== title.id) continue;
    const target = byId.get(relation.toTitleId);
    if (target === undefined) continue;
    const label = RELATION_LABEL[relation.relationType] ?? relation.relationType;
    groups.set(label, [...(groups.get(label) ?? []), displayTitle(target)]);
  }
  return [...groups.entries()].map(([label, names]) => [label, names.join(', ')]);
}

function FranchiseView({ franchise }: { franchise: Franchise }) {
  const { totals } = franchise;
  return (
    <div className="grid max-w-4xl gap-8">
      <header className="grid gap-2">
        <p className="text-mute text-sm font-medium tracking-wide uppercase">Franchise</p>
        <h1 className="font-serif text-2xl leading-tight font-semibold tracking-tight">
          {franchise.name}
        </h1>
        <p role="status">
          {totals.titles} {totals.titles === 1 ? 'title' : 'titles'}.{' '}
          {totals.inLibrary === 0
            ? 'None of them are on your shelf yet.'
            : `${totals.inLibrary} on your shelf, ${totals.completed} completed.`}
        </p>
      </header>
      <ol aria-label="Titles in this franchise, oldest first" className="grid list-none gap-6 p-0">
        {franchise.titles.map((title) => {
          const name = displayTitle(title);
          const lines = relationLines(franchise, title);
          return (
            <li key={title.id}>
              <article className="has-[:focus-visible]:outline-accent border-rule relative grid grid-cols-[72px_1fr] gap-4 border-t pt-4 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-4">
                <div className="bg-raised border-rule aspect-[2/3] overflow-hidden rounded-sm border">
                  {title.coverUrl === null ? (
                    <div className="text-mute font-serif grid h-full place-items-center p-1 text-center text-xs">
                      {name}
                    </div>
                  ) : (
                    <img
                      src={title.coverUrl}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      className="size-full object-cover"
                    />
                  )}
                </div>
                <div className="grid content-start gap-1">
                  <h2 className="font-serif text-lg leading-snug font-semibold">
                    <Link
                      to={`/title/${title.id}`}
                      className="focus-visible:outline-none after:absolute after:inset-0"
                    >
                      {name}
                    </Link>
                  </h2>
                  <p className="text-mute text-sm">
                    {metaLine(title)}
                    {title.startDate !== null && ` · ${title.startDate}`}
                  </p>
                  <p className="text-sm font-medium">
                    {title.libraryStatus === null
                      ? 'Not on your shelf'
                      : `On your shelf: ${ENTRY_LABEL[title.libraryStatus]}`}
                  </p>
                  {lines.length > 0 && (
                    <dl className="text-mute mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
                      {lines.map(([label, names]) => (
                        <div key={label} className="contents">
                          <dt>{label}</dt>
                          <dd>{names}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </div>
              </article>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function FranchisePage() {
  const { franchiseId = '' } = useParams();
  const { client } = useAuth();
  const { state, retry } = useRemote(`franchise:${franchiseId}`, () =>
    client.explore.franchise(franchiseId),
  );
  usePageTitle(state.phase === 'ready' ? state.value.data.name : 'Franchise');
  return (
    <Unavailable state={state} what="franchise" retry={retry}>
      {(response) => <FranchiseView franchise={response.data} />}
    </Unavailable>
  );
}

// ── Studio ────────────────────────────────────────────────────────────────────

function StudioWorks({ studioId }: { studioId: string }) {
  const { client } = useAuth();
  const { state, loadMore, retry } = useTitleList(`studio:${studioId}`, (cursor) =>
    client.explore.studioTitles(studioId, cursor === undefined ? {} : { cursor }),
  );
  return (
    <TitleResults
      state={state}
      label="Works"
      empty={<p>No works are saved for this studio yet.</p>}
      onRetry={retry}
      onLoadMore={loadMore}
    />
  );
}

export function StudioPage() {
  const { studioId = '' } = useParams();
  const { client } = useAuth();
  const { state, retry } = useRemote(`studio:${studioId}`, () => client.explore.studio(studioId));
  usePageTitle(state.phase === 'ready' ? state.value.data.name : 'Studio');
  return (
    <Unavailable state={state} what="studio" retry={retry}>
      {(response) => (
        <div className="grid gap-8">
          <header className="grid max-w-prose gap-2">
            <p className="text-mute text-sm font-medium tracking-wide uppercase">Studio</p>
            <h1 className="font-serif text-2xl leading-tight font-semibold tracking-tight">
              {response.data.name}
            </h1>
            <p>
              {response.data.titleCount} {response.data.titleCount === 1 ? 'work' : 'works'} saved
              in Akiba. The list grows as titles are opened.
            </p>
          </header>
          <section aria-labelledby="works-heading" className="grid gap-4">
            <h2 id="works-heading" className="font-serif text-xl font-semibold">
              Works
            </h2>
            <StudioWorks studioId={studioId} />
          </section>
        </div>
      )}
    </Unavailable>
  );
}

// ── Character ─────────────────────────────────────────────────────────────────

export function CharacterPage() {
  const { characterId = '' } = useParams();
  const { client } = useAuth();
  const { state, retry } = useRemote(`character:${characterId}`, () =>
    client.explore.character(characterId),
  );
  usePageTitle(state.phase === 'ready' ? state.value.data.name : 'Character');
  return (
    <Unavailable state={state} what="character" retry={retry}>
      {({ data: character }) => (
        <div className="grid max-w-5xl gap-10">
          <div className="grid gap-6 min-[560px]:grid-cols-[200px_1fr]">
            <div className="bg-raised border-rule aspect-[2/3] overflow-hidden rounded-sm border">
              {character.imageUrl === null ? (
                <div className="text-mute font-serif grid h-full place-items-center p-4 text-center text-xl">
                  {character.name}
                </div>
              ) : (
                <img
                  src={character.imageUrl}
                  alt={`Portrait of ${character.name}`}
                  className="size-full object-cover"
                />
              )}
            </div>
            <div className="grid content-start gap-4">
              <div>
                <p className="text-mute text-sm font-medium tracking-wide uppercase">Character</p>
                <h1 className="font-serif text-2xl leading-tight font-semibold tracking-tight">
                  {character.name}
                </h1>
                {character.nativeName !== null && (
                  <p lang="ja" className="text-mute">
                    {character.nativeName}
                  </p>
                )}
              </div>
              {character.voiceActors.length > 0 && (
                <dl className="grid max-w-xl grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
                  {character.voiceActors.map((actor) => (
                    <div key={`${actor.id}-${actor.language}`} className="contents">
                      <dt className="text-mute">Voiced by ({actor.language})</dt>
                      <dd>
                        {actor.name}
                        {actor.nativeName !== null && (
                          <>
                            {' '}
                            <span lang="ja" className="text-mute">
                              {actor.nativeName}
                            </span>
                          </>
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              {character.description !== null &&
                character.description.split(/\n{2,}/).map((paragraph, index) => (
                  <p key={index} className="max-w-prose whitespace-pre-line">
                    {paragraph}
                  </p>
                ))}
            </div>
          </div>
          <section aria-labelledby="appearances-heading" className="grid gap-4">
            <h2 id="appearances-heading" className="font-serif text-xl font-semibold">
              Appears in
            </h2>
            <PosterGrid label="Appearances">
              {character.appearances.map((appearance) => (
                <li key={appearance.title.id} className="grid content-start gap-1">
                  <PosterCard title={appearance.title} />
                  <p className="text-sm font-medium">{ROLE_LABEL[appearance.role]}</p>
                </li>
              ))}
            </PosterGrid>
          </section>
        </div>
      )}
    </Unavailable>
  );
}
