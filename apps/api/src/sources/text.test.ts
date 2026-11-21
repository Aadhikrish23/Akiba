import { describe, expect, it } from 'vitest';
import { characterDescription } from './text.js';

describe('characterDescription (FR-EXP-004)', () => {
  it('drops spoilers, keeps link text, removes emphasis marks', () => {
    expect(
      characterDescription(
        '__Height:__ 170 cm\nBorn to [Carla](https://anilist.co/character/1/x). ~!He dies in episode 9!~ Later he lives.',
      ),
    ).toBe('Height: 170 cm\nBorn to Carla. Later he lives.');
  });

  it('handles an unterminated spoiler by keeping the text (nothing to hide safely)', () => {
    expect(characterDescription('Hello ~!oops')).toContain('Hello');
  });

  it('caps long text and returns null for nothing', () => {
    expect(characterDescription('a'.repeat(5000))?.length).toBe(2000);
    expect(characterDescription('~!all secret!~')).toBeNull();
    expect(characterDescription(null)).toBeNull();
    expect(characterDescription('')).toBeNull();
  });
});
