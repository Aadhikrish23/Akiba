import { describe, expect, it } from 'vitest';
import { ADULT_GENRES, isAdultGenre, isAdultTagGenre, isExplicitGenre } from './genres.js';

describe('genres', () => {
  it('knows the adult genres, whatever the case', () => {
    for (const name of ADULT_GENRES) expect(isAdultGenre(name.toLowerCase())).toBe(true);
    expect(isAdultGenre('Action')).toBe(false);
  });

  it('keeps Hentai out of the adult genres: it is explicit and never offered', () => {
    expect(isExplicitGenre('HENTAI')).toBe(true);
    expect(isAdultGenre('Hentai')).toBe(false);
    expect(isExplicitGenre('Ecchi')).toBe(false);
  });

  it('asks for Harem as a tag and Ecchi as a genre', () => {
    expect(isAdultTagGenre('harem')).toBe(true);
    expect(isAdultTagGenre('Ecchi')).toBe(false);
  });
});
