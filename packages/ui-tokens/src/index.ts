/** Colour schemes every token set must provide (UX design: light and dark). */
export const COLOR_SCHEMES = ['light', 'dark'] as const;

export type ColorScheme = (typeof COLOR_SCHEMES)[number];

/** Base spacing unit in px; the spacing scale is expressed as multiples of it. */
export const SPACING_UNIT_PX = 4;

/**
 * Placeholder scale helper. The real "Shelf" tokens (colours, type scale,
 * spacing) from doc 08 are added in T7.
 */
export function spacing(steps: number): number {
  if (!Number.isInteger(steps) || steps < 0) {
    throw new RangeError(`spacing steps must be a non-negative integer, received ${steps}`);
  }
  return steps * SPACING_UNIT_PX;
}
