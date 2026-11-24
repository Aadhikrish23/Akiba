import { describe, expect, it } from 'vitest';
import { mainLineOf } from './franchise.js';

const edge = (from: string, to: string, type: string) => ({ from, to, type });

describe('mainLineOf', () => {
  // s1 → s2 → s3 is the chain; a movie and a spin-off hang off the side; the spin-off has its own sequel.
  const edges = [
    edge('s1', 's2', 'sequel'),
    edge('s2', 's1', 'prequel'),
    edge('s2', 's3', 'sequel'),
    edge('s3', 's2', 'prequel'),
    edge('s1', 'movie', 'side_story'),
    edge('movie', 's1', 'side_story'),
    edge('s1', 'spin1', 'spin_off'),
    edge('spin1', 's1', 'parent_story'),
    edge('spin1', 'spin2', 'sequel'),
    edge('spin2', 'spin1', 'prequel'),
  ];

  it('follows prequels and sequels from the root, in either direction', () => {
    expect([...mainLineOf('s1', edges)].sort()).toEqual(['s1', 's2', 's3']);
    expect([...mainLineOf('s3', edges)].sort()).toEqual(['s1', 's2', 's3']);
  });

  it('leaves out what hangs off the side, and the chain of a spin-off', () => {
    const line = mainLineOf('s1', edges);
    expect(line.has('movie')).toBe(false);
    expect(line.has('spin1')).toBe(false);
    expect(line.has('spin2')).toBe(false);
  });

  it('is just the root when nothing is a prequel or sequel of it', () => {
    expect([...mainLineOf('movie', edges)]).toEqual(['movie']);
    expect([...mainLineOf('x', [])]).toEqual(['x']);
  });

  it('copes with a loop in the links', () => {
    const loop = [edge('a', 'b', 'sequel'), edge('b', 'a', 'sequel')];
    expect([...mainLineOf('a', loop)].sort()).toEqual(['a', 'b']);
  });
});
