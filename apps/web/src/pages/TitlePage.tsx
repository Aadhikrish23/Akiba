import { ApiError } from '@akiba/api-client';
import {
  ROLE_LABEL,
  type RelationsResponse,
  type TitleCharactersResponse,
  type TitleDetailResponse,
} from '@akiba/shared';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { PosterCard, PosterGrid } from '../components/PosterCard';
import { ShelfPanel } from '../components/ShelfPanel';
import { Button, Notice } from '../components/ui';
import { describeError } from '../lib/errors';
import { usePageTitle } from '../lib/page';
import {
  KIND_LABEL,
  RELATION_LABEL,
  SEASON_LABEL,
  STATUS_LABEL,
  displayTitle,
  otherTitles,
} from '../lib/titles';
import { formatAirTime } from './Inbox';

type Load =
  | { phase: 'loading' }
  | { phase: 'missing' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; response: TitleDetailResponse };

/**
 * A title page (FR-DISC-004, -005, -007): names, facts, synopsis, where it airs next, the user's own
 * status, and what it is related to. Related titles load separately so a slow or failed relation
 * lookup never hides the page.
 */
export function TitlePage() {
  const { titleId = '' } = useParams();
  const { client, profile } = useAuth();
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [relations, setRelations] = useState<RelationsResponse | 'failed' | null>(null);
  const [cast, setCast] = useState<TitleCharactersResponse | 'failed' | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setLoad({ phase: 'loading' });
    setRelations(null);
    setCast(null);
    client.titles
      .detail(titleId)
      .then((response) => {
        if (live) setLoad({ phase: 'ready', response });
      })
      .catch((error: unknown) => {
        if (!live) return;
        if (error instanceof ApiError && error.status === 404) setLoad({ phase: 'missing' });
        else
          setLoad({
            phase: 'error',
            message:
              error instanceof ApiError && error.code === 'SOURCES_UNAVAILABLE'
                ? 'The anime catalog is temporarily unavailable and this title has not been saved yet. Try again in a moment.'
                : describeError(error).message,
          });
      });
    client.titles
      .relations(titleId)
      .then((response) => {
        if (live) setRelations(response);
      })
      .catch(() => {
        if (live) setRelations('failed');
      });
    client.titles
      .characters(titleId)
      .then((response) => {
        if (live) setCast(response);
      })
      .catch(() => {
        if (live) setCast('failed');
      });
    return () => {
      live = false;
    };
  }, [client, titleId, attempt]);

  const retry = useCallback(() => {
    setAttempt((value) => value + 1);
  }, []);

  const name = load.phase === 'ready' ? displayTitle(load.response.data) : 'Title';
  usePageTitle(name);

  if (load.phase === 'loading') {
    return (
      <div
        aria-busy="true"
        role="status"
        aria-label="Loading title"
        className="grid max-w-4xl gap-6 min-[560px]:grid-cols-[200px_1fr]"
      >
        <div className="bg-rule/50 aspect-[2/3] rounded-sm" />
        <div className="grid content-start gap-3" aria-hidden="true">
          <div className="bg-rule/50 h-8 w-3/4 rounded-sm" />
          <div className="bg-rule/50 h-4 w-1/2 rounded-sm" />
          <div className="bg-rule/50 h-24 rounded-sm" />
        </div>
      </div>
    );
  }
  if (load.phase === 'missing') {
    return (
      <div className="grid max-w-prose gap-3">
        <h1 className="h-title">Title not found</h1>
        <p className="text-mute">This title does not exist, or it is not available.</p>
        <p>
          <Link to="/discover" className="underline underline-offset-4">
            Back to Discover
          </Link>
        </p>
      </div>
    );
  }
  if (load.phase === 'error') {
    return (
      <div className="grid max-w-prose gap-4">
        <h1 className="h-title">Title</h1>
        <Notice tone="error">{load.message}</Notice>
        <div>
          <Button onClick={retry}>Try again</Button>
        </div>
      </div>
    );
  }

  const { data: title, meta } = load.response;
  const facts: [string, ReactNode][] = [
    ['Format', title.format ?? KIND_LABEL[title.kind]],
    ['Status', STATUS_LABEL[title.status]],
  ];
  if (title.episodesTotal !== null) facts.push(['Episodes', String(title.episodesTotal)]);
  if (title.durationMin !== null) facts.push(['Episode length', `${title.durationMin} min`]);
  if (title.seasonYear !== null) {
    facts.push([
      'Season',
      title.season === null
        ? String(title.seasonYear)
        : `${SEASON_LABEL[title.season]} ${title.seasonYear}`,
    ]);
  }
  if (title.startDate !== null) facts.push(['Started', title.startDate]);
  if (title.endDate !== null) facts.push(['Ended', title.endDate]);
  if (title.averageScore !== null) facts.push(['Average score', `${title.averageScore} / 100`]);
  if (title.studios.length > 0) {
    facts.push([
      'Studios',
      title.studios.map((studio, index) => (
        <span key={studio.id}>
          {index > 0 && ', '}
          <Link to={`/studio/${studio.id}`} className="underline underline-offset-4">
            {studio.name}
          </Link>
        </span>
      )),
    ]);
  }

  return (
    <article className="grid max-w-5xl gap-10">
      {title.bannerUrl !== null && (
        <div
          className="relative -mb-4 h-36 overflow-hidden rounded-lg min-[880px]:h-56"
          aria-hidden="true"
        >
          <img src={title.bannerUrl} alt="" className="size-full object-cover" />
          <div className="from-paper/10 to-paper/95 absolute inset-0 bg-gradient-to-b" />
        </div>
      )}
      <div className="grid gap-6 min-[560px]:grid-cols-[200px_1fr]">
        <div
          className={`bg-raised-2 aspect-[2/3] w-40 overflow-hidden rounded-md shadow-xl min-[560px]:w-auto ${
            title.bannerUrl !== null ? 'relative z-10 -mt-20 ml-4 -rotate-2 min-[560px]:ml-6' : ''
          }`}
        >
          {title.coverUrl === null ? (
            <div className="text-mute grid h-full place-items-center p-4 text-center text-xl font-display font-extrabold uppercase">
              {name}
            </div>
          ) : (
            <img src={title.coverUrl} alt={`Cover of ${name}`} className="size-full object-cover" />
          )}
        </div>
        <div className="grid content-start gap-4">
          <div>
            <h1 className="h-title">{name}</h1>
            {otherTitles(title).map((other) => (
              <p key={other.text} lang={other.lang} className="text-mute">
                {other.text}
              </p>
            ))}
          </div>

          {meta.stale && (
            <Notice>
              This is the copy saved earlier: the anime catalog could not be reached just now, so
              some details may be out of date.
            </Notice>
          )}
          {title.nextAiring !== null && (
            <p>
              Episode {title.nextAiring.episode} airs{' '}
              <time dateTime={title.nextAiring.airsAt}>
                {formatAirTime(title.nextAiring.airsAt, profile?.timeZone ?? 'UTC')}
              </time>
              .
            </p>
          )}

          <dl className="grid max-w-xl grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
            {facts.map(([term, value]) => (
              <div key={term} className="contents">
                <dt className="text-mute">{term}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>

          {title.genres.length > 0 && (
            <ul aria-label="Genres" className="flex list-none flex-wrap gap-2 p-0 text-sm">
              {title.genres.map((genre) => (
                <li key={genre} className="border-rule rounded-full border px-3 py-0.5">
                  {genre}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <ShelfPanel key={title.id} title={title} />

      {title.synopsis !== null && (
        <section aria-labelledby="synopsis-heading" className="grid max-w-prose gap-3">
          <h2 id="synopsis-heading" className="h-section">
            Synopsis
          </h2>
          {title.synopsis.split(/\n{2,}/).map((paragraph, index) => (
            <p key={index} className="whitespace-pre-line">
              {paragraph}
            </p>
          ))}
        </section>
      )}

      <section aria-labelledby="cast-heading" className="grid gap-4">
        <h2 id="cast-heading" className="h-section">
          Characters
        </h2>
        {cast === null && (
          <p role="status" aria-busy="true" className="text-mute">
            Loading characters…
          </p>
        )}
        {cast === 'failed' && <Notice>The characters could not be loaded just now.</Notice>}
        {cast !== null && cast !== 'failed' && cast.data.length === 0 && (
          <p className="text-mute">No characters are listed for this title yet.</p>
        )}
        {cast !== null && cast !== 'failed' && cast.data.length > 0 && (
          <ul
            aria-label="Characters"
            className="grid list-none gap-x-6 gap-y-3 p-0"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}
          >
            {cast.data.map((character) => (
              <li
                key={character.id}
                className="has-[:focus-visible]:outline-accent relative grid grid-cols-[48px_1fr] gap-3 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-4"
              >
                <div className="bg-raised border-rule aspect-square overflow-hidden rounded-sm border">
                  {character.imageUrl !== null && (
                    <img
                      src={character.imageUrl}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      className="size-full object-cover"
                    />
                  )}
                </div>
                <div className="grid content-center">
                  <Link
                    to={`/character/${character.id}`}
                    className="font-medium focus-visible:outline-none after:absolute after:inset-0"
                  >
                    {character.name}
                  </Link>
                  <p className="text-mute text-sm">
                    {ROLE_LABEL[character.role]}
                    {character.voiceActors[0] !== undefined &&
                      ` · voiced by ${character.voiceActors[0].name}`}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="related-heading" className="grid gap-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <h2 id="related-heading" className="h-section">
            Related titles
          </h2>
          {title.franchiseId !== null && (
            <Link to={`/franchise/${title.franchiseId}`} className="underline underline-offset-4">
              See the whole franchise
            </Link>
          )}
        </div>
        {relations === null && (
          <p role="status" aria-busy="true" className="text-mute">
            Loading related titles…
          </p>
        )}
        {relations === 'failed' && <Notice>Related titles could not be loaded just now.</Notice>}
        {relations !== null && relations !== 'failed' && relations.data.length === 0 && (
          <p className="text-mute">Nothing is related to this title yet.</p>
        )}
        {relations !== null &&
          relations !== 'failed' &&
          relations.data.map((group) => (
            <div key={group.relationType} className="grid gap-3">
              <h3 className="text-mute text-sm font-medium tracking-wide uppercase">
                {RELATION_LABEL[group.relationType] ?? group.relationType}
              </h3>
              <PosterGrid label={RELATION_LABEL[group.relationType] ?? group.relationType}>
                {group.titles.map((related) => (
                  <li key={related.id}>
                    <PosterCard title={related} />
                  </li>
                ))}
              </PosterGrid>
            </div>
          ))}
      </section>
    </article>
  );
}
