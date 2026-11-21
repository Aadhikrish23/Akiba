import { oklchToHex } from './color.js';

export * from './color.js';

/**
 * The "Shelf" design tokens (doc 08 §2), the single source for web (CSS variables, Tailwind
 * theme), mobile and desktop (sRGB hex). A change to doc 08 is a change here, and the tests
 * compare the two.
 */

/** Colour schemes every token set must provide (UX design: light and dark). */
export const COLOR_SCHEMES = ['light', 'dark'] as const;

export type ColorScheme = (typeof COLOR_SCHEMES)[number];

/** Base spacing unit in px; the spacing scale is expressed as multiples of it. */
export const SPACING_UNIT_PX = 4;

export function spacing(steps: number): number {
  if (!Number.isInteger(steps) || steps < 0) {
    throw new RangeError(`spacing steps must be a non-negative integer, received ${steps}`);
  }
  return steps * SPACING_UNIT_PX;
}

export const COLOR_NAMES = [
  'paper',
  'raised',
  'ink',
  'mute',
  'rule',
  'accent',
  'on-accent',
] as const;

export type ColorName = (typeof COLOR_NAMES)[number];

/** Source colours, as doc 08 writes them. `accent` is vermilion and is used for state only. */
export const oklchTokens: Readonly<Record<ColorName, Readonly<Record<ColorScheme, string>>>> = {
  paper: { light: 'oklch(96.5% 0.012 85)', dark: 'oklch(19% 0.012 60)' },
  raised: { light: 'oklch(99% 0.006 85)', dark: 'oklch(23.5% 0.014 60)' },
  ink: { light: 'oklch(22% 0.015 60)', dark: 'oklch(93% 0.012 85)' },
  mute: { light: 'oklch(48% 0.02 70)', dark: 'oklch(70% 0.02 80)' },
  rule: { light: 'oklch(88% 0.015 80)', dark: 'oklch(31% 0.015 60)' },
  accent: { light: 'oklch(55% 0.19 33)', dark: 'oklch(68% 0.17 38)' },
  'on-accent': { light: 'oklch(98% 0.01 85)', dark: 'oklch(18% 0.02 40)' },
};

/** The same colours as sRGB hex, for React Native and Electron. */
export const hexTokens: Readonly<Record<ColorScheme, Readonly<Record<ColorName, string>>>> = {
  light: Object.fromEntries(
    COLOR_NAMES.map((name) => [name, oklchToHex(oklchTokens[name].light)]),
  ) as Record<ColorName, string>,
  dark: Object.fromEntries(
    COLOR_NAMES.map((name) => [name, oklchToHex(oklchTokens[name].dark)]),
  ) as Record<ColorName, string>,
};

export const fontFamily = {
  /** Titles and headings. The final webfont is still open (doc 08 §2). */
  serif: '"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif',
  sans: 'ui-sans-serif, "Helvetica Neue", "Segoe UI", system-ui, sans-serif',
} as const;

/** Type scale in px (doc 08 §2: 11 / 13 / 15 / 18 / 24 / 32), rem-based on the web. */
export const typeScalePx = { xs: 11, sm: 13, base: 15, lg: 18, xl: 24, '2xl': 32 } as const;

export type TypeStep = keyof typeof typeScalePx;

/** Root font size the rem values are relative to. */
export const REM_PX = 16;

export const radiusPx = 2;

/** Longest transition (doc 08 §2: ≤ 150 ms); zero under `prefers-reduced-motion`. */
export const motionMaxMs = 150;

/** Responsive breakpoints in px (doc 08 §7). */
export const breakpointsPx = { sm: 560, md: 880, lg: 1200 } as const;

/** Page gutters: `clamp(16px, 4vw, 40px)` on the web. */
export const gutter = { minPx: 16, vw: 4, maxPx: 40 } as const;

const gutterCss = `clamp(${gutter.minPx}px, ${gutter.vw}vw, ${gutter.maxPx}px)`;
const rem = (px: number): string => `${px / REM_PX}rem`;

const cssName = (name: ColorName): string => `--${name}`;

const colourDeclarations = (pick: (name: ColorName) => string): string =>
  COLOR_NAMES.map((name) => `  ${cssName(name)}: ${pick(name)};`).join('\n');

/**
 * Plain CSS (no framework needed): the variables `--paper`, `--ink`, … follow the system scheme
 * through `light-dark()` (with a `prefers-color-scheme` fallback for browsers without it), and
 * `<html data-theme="light|dark">` forces one. The Settings screen is the only place that sets
 * the attribute (doc 08 §2).
 */
export function tokensCss(): string {
  const sourceVars = COLOR_NAMES.flatMap((name) => [
    `  ${cssName(name)}-l: ${oklchTokens[name].light};`,
    `  ${cssName(name)}-d: ${oklchTokens[name].dark};`,
  ]).join('\n');
  return `/* Generated from @akiba/ui-tokens. Do not edit by hand. */
:root {
  color-scheme: light dark;
${sourceVars}
${colourDeclarations((name) => `var(${cssName(name)}-l)`)}
  --serif: ${fontFamily.serif};
  --sans: ${fontFamily.sans};
  --gutter: ${gutterCss};
  --radius: ${radiusPx}px;
  --motion-fast: ${motionMaxMs}ms;
  accent-color: var(--accent);
}

@media (prefers-color-scheme: dark) {
  :root {
${colourDeclarations((name) => `var(${cssName(name)}-d)`)}
  }
}

@supports (color: light-dark(white, black)) {
  :root {
${colourDeclarations((name) => `light-dark(var(${cssName(name)}-l), var(${cssName(name)}-d))`)}
  }
}

:root[data-theme='light'] {
  color-scheme: light;
${colourDeclarations((name) => `var(${cssName(name)}-l)`)}
}

:root[data-theme='dark'] {
  color-scheme: dark;
${colourDeclarations((name) => `var(${cssName(name)}-d)`)}
}

@media (prefers-reduced-motion: reduce) {
  :root {
    --motion-fast: 0ms;
  }
}
`;
}

/**
 * Tailwind CSS v4 theme (`@import '@akiba/ui-tokens/tailwind.css'` after the tokens): maps the
 * variables above onto utilities (`bg-paper`, `text-ink`, `border-rule`, `font-serif`, `text-sm`,
 * `rounded-*`, breakpoints). Utilities read the variables at run time, so the theme switch works
 * without rebuilding.
 */
export function tailwindThemeCss(): string {
  const colours = COLOR_NAMES.map((name) => `  --color-${name}: var(${cssName(name)});`).join('\n');
  const textSizes = (Object.entries(typeScalePx) as [TypeStep, number][])
    .map(([step, px]) => `  --text-${step}: ${rem(px)};`)
    .join('\n');
  const breakpoints = Object.entries(breakpointsPx)
    .map(([step, px]) => `  --breakpoint-${step}: ${px}px;`)
    .join('\n');
  return `/* Generated from @akiba/ui-tokens. Do not edit by hand. */
@theme inline {
  --color-*: initial;
${colours}
  --font-*: initial;
  --font-serif: var(--serif);
  --font-sans: var(--sans);
  --text-*: initial;
${textSizes}
  --spacing: ${SPACING_UNIT_PX}px;
  --radius-*: initial;
  --radius-sm: var(--radius);
  --radius-md: var(--radius);
  --radius-lg: var(--radius);
  --breakpoint-*: initial;
${breakpoints}
}
`;
}
