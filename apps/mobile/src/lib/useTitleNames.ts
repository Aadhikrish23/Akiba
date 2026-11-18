import { otherTitleNames, titleNameIn, type TitleCard } from '@akiba/shared';
import { useAuth } from '../auth/AuthContext';

type Names = Pick<TitleCard, 'titleRomaji' | 'titleEnglish' | 'titleNative'>;

/** Title names in the language the reader chose in their settings (romaji until it is read). */
export function useTitleNames() {
  const { profile } = useAuth();
  const language = profile?.titleLanguage ?? 'romaji';
  return {
    name: (title: Names) => titleNameIn(title, language),
    others: (title: Names) => otherTitleNames(title, language),
  };
}
