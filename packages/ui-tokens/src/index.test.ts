import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  COLOR_NAMES,
  COLOR_SCHEMES,
  SPACING_UNIT_PX,
  breakpointsPx,
  contrastRatio,
  displayScalePx,
  hexTokens,
  motionMaxMs,
  oklchTokens,
  oklchToHex,
  parseOklch,
  radiusLgPx,
  radiusMdPx,
  radiusPx,
  spacing,
  tailwindThemeCss,
  ticketStock,
  tokensCss,
  typeScalePx,
} from './index.js';

const DOC_08 = readFileSync(new URL('../../../docs/08-ux-design.md', import.meta.url), 'utf8');

describe('@akiba/ui-tokens: scale helpers', () => {
  it('provides light and dark schemes', () => {
    expect(COLOR_SCHEMES).toEqual(['light', 'dark']);
  });

  it('scales spacing from the base unit', () => {
    expect(spacing(0)).toBe(0);
    expect(spacing(3)).toBe(3 * SPACING_UNIT_PX);
  });

  it.each([-1, 1.5, Number.NaN])('rejects %s steps', (steps) => {
    expect(() => spacing(steps)).toThrow(RangeError);
  });
});

describe('@akiba/ui-tokens: match doc 08 §2', () => {
  /** Rows of the colour table: name → [light, dark] oklch strings. */
  const docColours = new Map<string, [string, string]>();
  for (const line of DOC_08.split(/\r?\n/)) {
    const row =
      /^\|\s*`([a-z0-9-]+)`[^|]*\|\s*`(oklch\([^`]+\))`\s*\|\s*`(oklch\([^`]+\))`\s*\|$/.exec(line);
    if (row?.[1] !== undefined && row[2] !== undefined && row[3] !== undefined) {
      docColours.set(row[1], [row[2], row[3]]);
    }
  }

  it('finds every token row in the document', () => {
    expect([...docColours.keys()].sort()).toEqual([...COLOR_NAMES].sort());
  });

  it.each(COLOR_NAMES)('%s has the light and dark values of the document', (name) => {
    const [light, dark] = docColours.get(name) ?? ['', ''];
    expect(parseOklch(oklchTokens[name].light)).toEqual(parseOklch(light));
    expect(parseOklch(oklchTokens[name].dark)).toEqual(parseOklch(dark));
  });

  it('uses the type scale, spacing base, radius, motion cap and breakpoints of the document', () => {
    expect(Object.values(typeScalePx)).toEqual([11, 13, 15, 18, 24, 32]);
    expect(DOC_08).toContain('**Scale:** 11 / 13 / 15 / 18 / 24 / 32 px');
    expect(SPACING_UNIT_PX).toBe(4);
    expect([radiusPx, radiusMdPx, radiusLgPx]).toEqual([6, 10, 14]);
    expect(Object.values(displayScalePx)).toEqual([40, 56, 84]);
    expect(motionMaxMs).toBe(150);
    expect(Object.values(breakpointsPx)).toEqual([560, 880, 1200]);
    expect(DOC_08).toContain('Breakpoints 560 / 880 / 1200 px');
  });
});

describe('@akiba/ui-tokens: colour conversion', () => {
  const channels = (hex: string): [number, number, number] => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];

  it('maps black, white and a neutral grey', () => {
    expect(oklchToHex('oklch(100% 0 0)')).toBe('#ffffff');
    expect(oklchToHex('oklch(0% 0 0)')).toBe('#000000');
    for (const channel of channels(oklchToHex('oklch(56.92% 0 0)'))) {
      expect(Math.abs(channel - 0x77)).toBeLessThanOrEqual(1);
    }
  });

  it('maps sRGB red to within one step per channel', () => {
    const [r, g, b] = channels(oklchToHex('oklch(62.8% 0.2577 29.23)'));
    expect(r).toBeGreaterThanOrEqual(254);
    expect(g).toBeLessThanOrEqual(2);
    expect(b).toBeLessThanOrEqual(2);
  });

  it('keeps an out-of-gamut colour on its hue instead of clipping it', () => {
    // Far outside sRGB; clipping channels would turn it a different colour.
    const [r, g, b] = channels(oklchToHex('oklch(70% 0.4 150)'));
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
  });

  it('rejects text that is not an oklch colour', () => {
    expect(() => parseOklch('#ff0000')).toThrow(SyntaxError);
    expect(() => parseOklch('oklch(55 0.19 33)')).toThrow(SyntaxError);
  });

  it('produces a #rrggbb value for every token in both schemes', () => {
    for (const scheme of COLOR_SCHEMES) {
      for (const name of COLOR_NAMES) {
        expect(hexTokens[scheme][name], `${scheme}/${name}`).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it('computes WCAG contrast (black on white is 21:1, identical colours 1:1)', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#336699', '#336699')).toBeCloseTo(1, 5);
  });
});

describe('@akiba/ui-tokens: accessibility of the palette (doc 08 §6, WCAG 2.2 AA)', () => {
  const pairs: readonly [string, string, string, number][] = [
    ['ink on paper', 'ink', 'paper', 4.5],
    ['ink on raised', 'ink', 'raised', 4.5],
    ['mute on paper', 'mute', 'paper', 4.5],
    ['mute on raised', 'mute', 'raised', 4.5],
    ['on-accent on accent', 'on-accent', 'accent', 4.5],
    // The accent marks state (progress, focus ring, active tab); doc 08 asks for ≥ 3:1 for UI.
    ['accent on paper', 'accent', 'paper', 3],
    ['accent on raised', 'accent', 'raised', 3],
    ['danger on paper', 'danger', 'paper', 4.5],
    ['danger on raised', 'danger', 'raised', 4.5],
    ['ink on raised-2', 'ink', 'raised-2', 4.5],
    ['mute on raised-2', 'mute', 'raised-2', 4.5],
  ];

  for (const scheme of COLOR_SCHEMES) {
    it.each(pairs)(`${scheme}: %s`, (_label, foreground, background, minimum) => {
      const colours = hexTokens[scheme];
      const ratio = contrastRatio(
        colours[foreground as keyof typeof colours],
        colours[background as keyof typeof colours],
      );
      expect(ratio).toBeGreaterThanOrEqual(minimum);
    });
  }
});

describe('@akiba/ui-tokens: ticket stock (doc 08 §2)', () => {
  it('prints stub-ink at 4.5:1 or better on every stock colour, in both schemes', () => {
    for (const scheme of COLOR_SCHEMES) {
      for (const stock of ticketStock) {
        const ratio = contrastRatio(hexTokens[scheme]['stub-ink'], stock);
        expect(ratio, `${scheme} ${stock}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe('@akiba/ui-tokens: generated CSS', () => {
  const css = tokensCss();

  it('defines every colour for both schemes and resolves them through light-dark()', () => {
    for (const name of COLOR_NAMES) {
      expect(css).toContain(`--${name}-l: ${oklchTokens[name].light};`);
      expect(css).toContain(`--${name}-d: ${oklchTokens[name].dark};`);
      expect(css).toContain(`--${name}: light-dark(var(--${name}-l), var(--${name}-d));`);
    }
  });

  it('keeps a prefers-color-scheme fallback and a manual override', () => {
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(css).toContain(":root[data-theme='light']");
    expect(css).toContain(":root[data-theme='dark']");
  });

  it('zeroes motion under prefers-reduced-motion', () => {
    expect(css).toMatch(/prefers-reduced-motion: reduce\)[^}]*--motion-fast: 0ms/s);
  });

  it('maps the tokens onto a Tailwind v4 theme without a self-referencing variable', () => {
    const theme = tailwindThemeCss();
    expect(theme).toContain('@theme inline');
    expect(theme).toContain('--color-paper: var(--paper);');
    expect(theme).toContain('--color-on-accent: var(--on-accent);');
    expect(theme).toContain('--text-xs: 0.6875rem;');
    expect(theme).toContain('--breakpoint-md: 880px;');
    expect(theme).toContain('--font-display: var(--display);');
    expect(theme).toContain('--text-d1: 2.5rem;');
    expect(theme).not.toContain('--font-display: var(--font-display)');
  });
});
