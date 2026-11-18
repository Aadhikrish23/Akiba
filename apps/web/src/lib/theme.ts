export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'akiba.theme';

/** The saved choice, or `system`. Storage can be blocked (private windows): then it is `system`. */
export function readTheme(): ThemeChoice {
  try {
    const value = window.localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

/**
 * Apply a theme choice. The tokens follow the system scheme by default (`light-dark()`); the
 * manual override is the `data-theme` attribute, set only from Settings (doc 08 §2). Nothing
 * sensitive is stored: only the word `light` or `dark`.
 */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
  try {
    if (choice === 'system') window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, choice);
  } catch {
    // The choice still applies for this visit.
  }
}
