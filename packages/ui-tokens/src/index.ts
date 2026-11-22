import { oklchToHex } from './color.js';

export * from './color.js';

/**
 * The "Ticket Stub Night" design tokens (doc 08 §2), the single source for web (CSS variables, Tailwind
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
  'raised-2',
  'ink',
  'mute',
  'rule',
  'accent',
  'on-accent',
  'danger',
  'stub-ink',
] as const;

export type ColorName = (typeof COLOR_NAMES)[number];

/**
 * Source colours, as doc 08 writes them. Dark is the night-time cinema lobby, light the same
 * lobby by day. `accent` is the one colour that means "press me" (and focus); `stub-ink` is the
 * ink printed on a ticket's coloured stock, the same in both schemes.
 */
export const oklchTokens: Readonly<Record<ColorName, Readonly<Record<ColorScheme, string>>>> = {
  paper: { light: 'oklch(96.5% 0.012 85)', dark: 'oklch(16% 0.035 265)' },
  raised: { light: 'oklch(99% 0.006 85)', dark: 'oklch(20.5% 0.04 265)' },
  'raised-2': { light: 'oklch(93% 0.012 85)', dark: 'oklch(26% 0.045 265)' },
  ink: { light: 'oklch(20% 0.04 265)', dark: 'oklch(95% 0.012 90)' },
  mute: { light: 'oklch(44% 0.035 265)', dark: 'oklch(74% 0.035 265)' },
  rule: { light: 'oklch(86% 0.015 85)', dark: 'oklch(32% 0.045 265)' },
  accent: { light: 'oklch(40% 0.1 165)', dark: 'oklch(90% 0.15 165)' },
  'on-accent': { light: 'oklch(97% 0.02 165)', dark: 'oklch(20% 0.05 200)' },
  danger: { light: 'oklch(46% 0.18 28)', dark: 'oklch(74% 0.15 25)' },
  'stub-ink': { light: 'oklch(19% 0.04 265)', dark: 'oklch(19% 0.04 265)' },
};

/**
 * Ticket stock: the colours a ticket is printed on. Until the catalog supplies each cover's own
 * colour, a title takes one of these, chosen from its id (see `stockFor` in the web app). The
 * `stub-ink` text on every one of them is at least 4.5:1 (tested).
 */
export const ticketStock = [
  '#e4a128',
  '#f1ae50',
  '#aebb35',
  '#c99350',
  '#5aa6ee',
  '#e4a143',
  '#e45d5d',
  '#bbf1a1',
  '#f1d65d',
  '#f17843',
  '#e4c993',
  '#ffd6ae',
] as const;

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
  /** Native apps without the webfonts: titles in the platform serif (see apps/mobile). */
  serif: '"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif',
  /** Body and controls: Zen Kaku Gothic New, which also sets the Japanese text. */
  sans: '"Zen Kaku Gothic New", ui-sans-serif, "Helvetica Neue", "Segoe UI", system-ui, sans-serif',
  /** Titles, big numerals and day names: Big Shoulders Display, condensed, with a weight axis. */
  display:
    '"Big Shoulders Display Variable", "Big Shoulders Display", "Zen Kaku Gothic New", Impact, sans-serif',
  /** The handwritten note on a ticket. */
  hand: '"Yomogi", "Zen Kaku Gothic New", cursive',
} as const;

/** Type scale in px (doc 08 §2: 11 / 13 / 15 / 18 / 24 / 32), rem-based on the web. */
export const typeScalePx = { xs: 11, sm: 13, base: 15, lg: 18, xl: 24, '2xl': 32 } as const;

export type TypeStep = keyof typeof typeScalePx;

/** Display sizes for ticket numerals and page titles, in px (clamped down on narrow screens). */
export const displayScalePx = { d1: 40, d2: 56, d3: 84 } as const;

/** Root font size the rem values are relative to. */
export const REM_PX = 16;

/** Corner radii in px: controls, tickets and posters, and the largest surfaces. */
export const radiusPx = 6;
export const radiusMdPx = 10;
export const radiusLgPx = 14;

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
  --display: ${fontFamily.display};
  --hand: ${fontFamily.hand};
  --gutter: ${gutterCss};
  --radius: ${radiusPx}px;
  --radius-md: ${radiusMdPx}px;
  --radius-lg: ${radiusLgPx}px;
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
  const displaySizes = (Object.entries(displayScalePx) as [string, number][])
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
  --font-sans: var(--sans);
  --font-display: var(--display);
  --font-hand: var(--hand);
  --text-*: initial;
${textSizes}
${displaySizes}
  --spacing: ${SPACING_UNIT_PX}px;
  --radius-*: initial;
  --radius-sm: var(--radius);
  --radius-md: var(--radius-md);
  --radius-lg: var(--radius-lg);
  --breakpoint-*: initial;
${breakpoints}
}
`;
}
