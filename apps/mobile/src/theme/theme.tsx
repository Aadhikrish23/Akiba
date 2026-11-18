import { hexTokens, spacing, typeScalePx, type ColorScheme } from '@akiba/ui-tokens';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { Platform, useColorScheme } from 'react-native';

/**
 * The "Shelf" tokens (doc 08 §2) for React Native: the same colours as the web app, as sRGB hex,
 * light or dark following the device. Spacing is the 4 px scale; type is the 11…32 scale.
 */
export interface Theme {
  readonly scheme: ColorScheme;
  readonly colors: (typeof hexTokens)[ColorScheme];
  readonly space: typeof spacing;
  readonly type: typeof typeScalePx;
  readonly fonts: { readonly serif: string; readonly sans: string | undefined };
  /** Hairline for borders and rules. */
  readonly hairline: number;
  /** Corner radius (doc 08: near-square). */
  readonly radius: number;
}

/** Georgia is on every iOS device; Android's generic `serif` is Noto Serif. */
const SERIF = Platform.select({ ios: 'Georgia', android: 'serif', default: 'Georgia, serif' });

export function themeFor(scheme: ColorScheme): Theme {
  return {
    scheme,
    colors: hexTokens[scheme],
    space: spacing,
    type: typeScalePx,
    fonts: { serif: SERIF, sans: undefined },
    hairline: 1,
    radius: 2,
  };
}

const ThemeContext = createContext<Theme | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const device = useColorScheme();
  const scheme: ColorScheme = device === 'dark' ? 'dark' : 'light';
  const value = useMemo(() => themeFor(scheme), [scheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  const value = useContext(ThemeContext);
  if (value === null) throw new Error('useTheme must be used inside <ThemeProvider>');
  return value;
}

/** The smallest a tap target may be (doc 08 §6: 44 pt). */
export const MIN_TARGET = 44;
