import { seasonOf } from '@akiba/shared';
import { Redirect } from 'expo-router';

/** `/season/current` jumps to the season it is now, so a link to it never goes stale. */
export default function CurrentSeason() {
  const { season, year } = seasonOf(new Date());
  return <Redirect href={{ pathname: '/season/[year]/[season]', params: { year, season } }} />;
}
