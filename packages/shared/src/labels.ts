import type { CharacterRole } from './explore.js';
import type { HistoryItem } from './library.js';
import type { EntryStatus, TitleCard, TitleKind, TitleStatus } from './titles.js';
import type { TitleLanguage } from './account.js';

/**
 * Words for the catalog's enums, shared by every client so the web app and the mobile app say the
 * same thing (doc 08 §8: plain words, one vocabulary). Pure: nothing here reads settings or state.
 */

export const KIND_LABEL: Readonly<Record<TitleKind, string>> = {
  tv: 'TV',
  movie: 'Movie',
  ova: 'OVA',
  ona: 'ONA',
  special: 'Special',
  tv_short: 'TV short',
  music: 'Music video',
};

export const STATUS_LABEL: Readonly<Record<TitleStatus, string>> = {
  finished: 'Finished',
  releasing: 'Airing',
  not_yet_released: 'Not yet released',
  cancelled: 'Cancelled',
  hiatus: 'On hiatus',
};

export const ENTRY_LABEL: Readonly<Record<EntryStatus, string>> = {
  watching: 'Watching',
  completed: 'Completed',
  planned: 'Planned',
  on_hold: 'On hold',
  dropped: 'Dropped',
};

export const SEASON_LABEL = {
  winter: 'Winter',
  spring: 'Spring',
  summer: 'Summer',
  fall: 'Fall',
} as const;

/** What a related title is to the title page it is listed on. */
export const RELATION_LABEL: Readonly<Record<string, string>> = {
  prequel: 'Before this',
  sequel: 'After this',
  parent_story: 'Main story',
  side_story: 'Side stories',
  spin_off: 'Spin-offs',
  alternative: 'Alternative versions',
  adaptation: 'Adaptations',
  summary: 'Summaries and recaps',
  other: 'Also related',
};

export const ROLE_LABEL: Readonly<Record<CharacterRole, string>> = {
  main: 'Main character',
  supporting: 'Supporting character',
  background: 'Background character',
};

type Names = Pick<TitleCard, 'titleRomaji' | 'titleEnglish' | 'titleNative'>;

/** A title's name in the reader's language (romaji by default, doc 08 §8), else whatever exists. */
export function titleNameIn(title: Names, language: TitleLanguage): string {
  const order =
    language === 'english'
      ? [title.titleEnglish, title.titleRomaji, title.titleNative]
      : language === 'native'
        ? [title.titleNative, title.titleRomaji, title.titleEnglish]
        : [title.titleRomaji, title.titleEnglish, title.titleNative];
  return order.find((name) => name !== null) ?? 'Untitled';
}

/** The other names worth showing under the main one. */
export function otherTitleNames(
  title: Names,
  language: TitleLanguage,
): { text: string; lang: 'en' | 'ja' | undefined }[] {
  const main = titleNameIn(title, language);
  const out: { text: string; lang: 'en' | 'ja' | undefined }[] = [];
  if (title.titleRomaji !== null && title.titleRomaji !== main) {
    out.push({ text: title.titleRomaji, lang: undefined });
  }
  if (title.titleEnglish !== null && title.titleEnglish !== main) {
    out.push({ text: title.titleEnglish, lang: 'en' });
  }
  if (title.titleNative !== null && title.titleNative !== main) {
    out.push({ text: title.titleNative, lang: 'ja' });
  }
  return out;
}

/** "TV · 25 episodes · Spring 2013": what a card shows under the name. */
export function metaLine(title: TitleCard): string {
  const parts: string[] = [KIND_LABEL[title.kind]];
  if (title.episodesTotal !== null) {
    parts.push(`${title.episodesTotal} ${title.episodesTotal === 1 ? 'episode' : 'episodes'}`);
  }
  if (title.seasonYear !== null) {
    parts.push(
      title.season === null
        ? String(title.seasonYear)
        : `${SEASON_LABEL[title.season]} ${title.seasonYear}`,
    );
  }
  return parts.join(' · ');
}

const num = (value: unknown): number | null => (typeof value === 'number' ? value : null);
const status = (value: unknown): string =>
  typeof value === 'string' && value in ENTRY_LABEL
    ? ENTRY_LABEL[value as keyof typeof ENTRY_LABEL]
    : String(value);

/** One event as a sentence a person would say (doc 08 §8: plain, specific). */
export function describeEvent(item: HistoryItem): string {
  const p = item.payload;
  switch (item.type) {
    case 'entry_added':
      return `Added to your library as ${status(p['status'])}`;
    case 'status_changed':
      return `Changed from ${status(p['from'])} to ${status(p['to'])}`;
    case 'progress_changed': {
      const from = num(p['from']);
      const to = num(p['to']);
      if (from !== null && to !== null && to === from + 1) return `Watched episode ${to}`;
      if (from !== null && to !== null && to > from) return `Watched episodes ${from + 1} to ${to}`;
      return `Set progress to ${to ?? '?'} (was ${from ?? '?'})`;
    }
    case 'run_started':
      return num(p['run_number']) === 1
        ? 'Started watching'
        : `Started rewatch ${num(p['run_number']) ?? ''}`.trim();
    case 'run_completed':
      return num(p['run_number']) === 1
        ? 'Finished watching'
        : `Finished rewatch ${num(p['run_number']) ?? ''}`.trim();
    case 'rated':
      return p['to'] === null ? 'Removed the rating' : `Rated ${num(p['to'])} out of 10`;
    case 'reviewed':
      return num(p['length']) === 0 ? 'Deleted the review' : 'Wrote a review';
    case 'favorited':
      return 'Marked as a favorite';
    case 'unfavorited':
      return 'Removed from favorites';
    case 'total_overridden':
      return `Changed the episode count to ${num(p['to']) ?? '?'}`;
    case 'total_override_cleared':
      return 'Reset the episode count';
    case 'entry_removed':
      return 'Removed from your library';
  }
}
