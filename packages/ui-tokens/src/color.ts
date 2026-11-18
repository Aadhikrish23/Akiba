/**
 * Colour maths for the tokens: parse `oklch()`, convert to sRGB hex (React Native and Electron
 * cannot read `oklch()`; doc 08 §2 says they get hex) and measure WCAG contrast (doc 08 §6).
 */

export interface Oklch {
  /** Lightness, 0–1. */
  readonly l: number;
  /** Chroma, ≥ 0. */
  readonly c: number;
  /** Hue in degrees. */
  readonly h: number;
}

const OKLCH_PATTERN = /^oklch\(\s*(\d*\.?\d+)%\s+(\d*\.?\d+)\s+(\d*\.?\d+)(?:deg)?\s*\)$/i;

/** Parse `oklch(55% 0.19 33)` (percentage lightness, as written in doc 08). */
export function parseOklch(value: string): Oklch {
  const match = OKLCH_PATTERN.exec(value.trim());
  if (match === null) throw new SyntaxError(`not an oklch() colour: "${value}"`);
  return { l: Number(match[1]) / 100, c: Number(match[2]), h: Number(match[3]) };
}

type Rgb = readonly [number, number, number];

/** Linear-light sRGB (unclamped) of an OKLCH colour, via OKLab (Björn Ottosson's matrices). */
function toLinearSrgb({ l, c, h }: Oklch): Rgb {
  const hue = (h * Math.PI) / 180;
  const a = c * Math.cos(hue);
  const b = c * Math.sin(hue);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

const GAMUT_EPSILON = 1e-6;
const inGamut = (rgb: Rgb): boolean =>
  rgb.every((channel) => channel >= -GAMUT_EPSILON && channel <= 1 + GAMUT_EPSILON);

const encode = (linear: number): number => {
  const clamped = Math.min(1, Math.max(0, linear));
  return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
};

/**
 * sRGB channels 0–255 (integers). A colour outside the sRGB gamut keeps its lightness and hue and
 * loses chroma until it fits, which is how CSS Color 4 maps it, instead of clipping channels
 * (clipping shifts the hue).
 */
export function oklchToRgb(colour: Oklch): [number, number, number] {
  let rgb = toLinearSrgb(colour);
  if (!inGamut(rgb)) {
    let low = 0;
    let high = colour.c;
    for (let step = 0; step < 24; step += 1) {
      const middle = (low + high) / 2;
      if (inGamut(toLinearSrgb({ ...colour, c: middle }))) low = middle;
      else high = middle;
    }
    rgb = toLinearSrgb({ ...colour, c: low });
  }
  return [
    Math.round(encode(rgb[0]) * 255),
    Math.round(encode(rgb[1]) * 255),
    Math.round(encode(rgb[2]) * 255),
  ];
}

const hex2 = (channel: number): string => channel.toString(16).padStart(2, '0');

export function rgbToHex(rgb: readonly [number, number, number]): string {
  return `#${hex2(rgb[0])}${hex2(rgb[1])}${hex2(rgb[2])}`;
}

/** `oklch(55% 0.19 33)` → `#c4452b`-style sRGB hex. */
export function oklchToHex(value: string): string {
  return rgbToHex(oklchToRgb(parseOklch(value)));
}

export function hexToRgb(hex: string): [number, number, number] {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (match === null) throw new SyntaxError(`not a #rrggbb colour: "${hex}"`);
  const [, red = '', green = '', blue = ''] = match;
  return [parseInt(red, 16), parseInt(green, 16), parseInt(blue, 16)];
}

const linearise = (channel: number): number => {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};

/** WCAG 2.x relative luminance of a `#rrggbb` colour. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * linearise(r) + 0.7152 * linearise(g) + 0.0722 * linearise(b);
}

/** WCAG 2.x contrast ratio, 1–21, of two `#rrggbb` colours (order does not matter). */
export function contrastRatio(a: string, b: string): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}
