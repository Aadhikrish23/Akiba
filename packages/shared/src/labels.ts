import type { CharacterRole } from './explore.js';
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
