import { SEASONS, seasonOf, shiftSeason, type Season } from '@akiba/shared';
import { Link, Navigate, useParams } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { TitleResults } from '../components/TitleResults';
import { usePageTitle } from '../lib/page';
import { SEASON_LABEL, useTitleList } from '../lib/titles';

const isSeason = (value: string | undefined): value is Season =>
  (SEASONS as readonly string[]).includes(value ?? '');

/** `/discover/season` jumps to the current season, so a bookmark of it never goes stale. */
export function CurrentSeasonRedirect() {
  const { season, year } = seasonOf(new Date());
  return <Navigate to={`/discover/season/${year}/${season}`} replace />;
}

/** Validates the address, then shows the chart; an invalid one goes to the current season. */
export function SeasonChartPage() {
  const params = useParams();
  const year = Number(params['year']);
  const season = params['season'];
  if (!Number.isInteger(year) || year < 1940 || year > 2100 || !isSeason(season)) {
    return <Navigate to="/discover/season" replace />;
  }
  return <SeasonChart year={year} season={season} />;
}

/**
 * The seasonal chart (FR-DISC-003): one season at a time with links to the one before and after,
 * so "the current and adjacent seasons" are one click apart.
 */
function SeasonChart({ year, season }: { year: number; season: Season }) {
  const { client } = useAuth();
  const current = { season, year };
  const label = `${SEASON_LABEL[season]} ${year}`;
  usePageTitle(`${label} season`);

  const { state, loadMore, retry } = useTitleList(`${year}-${season}`, (cursor) =>
    client.titles.season(year, season, { limit: 24, cursor }),
  );

  const before = shiftSeason(current, -1);
  const after = shiftSeason(current, 1);
  const href = (value: { season: Season; year: number }) =>
    `/discover/season/${value.year}/${value.season}`;

  return (
    <div className="grid gap-8">
      <div>
        <p className="text-mute text-sm">
          <Link to="/discover" className="underline underline-offset-4">
            Discover
          </Link>{' '}
          / Seasonal chart
        </p>
        <h1 className="h-title mt-1">{label}</h1>
        <nav aria-label="Seasons" className="mt-3 flex gap-6 text-sm">
          <Link to={href(before)} className="underline underline-offset-4">
            ← {SEASON_LABEL[before.season]} {before.year}
          </Link>
          <Link to={href(after)} className="underline underline-offset-4">
            {SEASON_LABEL[after.season]} {after.year} →
          </Link>
        </nav>
      </div>
      <h2 className="sr-only">Titles of the {label} season</h2>
      <TitleResults
        state={state}
        label={`${label} titles`}
        onRetry={retry}
        onLoadMore={loadMore}
        empty={<p>No titles are listed for this season yet.</p>}
      />
    </div>
  );
}
