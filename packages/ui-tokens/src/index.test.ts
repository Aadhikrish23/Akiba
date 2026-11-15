import { describe, expect, it } from 'vitest';
import { COLOR_SCHEMES, SPACING_UNIT_PX, spacing } from './index.js';

describe('@akiba/ui-tokens', () => {
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
