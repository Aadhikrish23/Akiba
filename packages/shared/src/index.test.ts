import { describe, expect, it } from 'vitest';
import { APP_NAME, PLATFORMS, isPlatform } from './index.js';

describe('@akiba/shared', () => {
  it('exposes the product name', () => {
    expect(APP_NAME).toBe('Akiba');
  });

  it('accepts every known platform', () => {
    for (const platform of PLATFORMS) {
      expect(isPlatform(platform)).toBe(true);
    }
  });

  it.each(['tv', '', 42, null, undefined])('rejects %j as a platform', (value) => {
    expect(isPlatform(value)).toBe(false);
  });
});
