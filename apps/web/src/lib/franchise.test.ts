import { describe, expect, it } from 'vitest';
import { franchiseSummary, groupByFranchise, type FranchiseInfo } from './franchise';

const franchise = (id: string): FranchiseInfo => ({
  id,
  size: 5,
  seasons: 4,
  titleRomaji: 'Boku no Hero Academia',
  titleEnglish: 'My Hero Academia',
  titleNative: null,
});

interface Item {
  readonly id: string;
  readonly franchise: FranchiseInfo | null;
}
const item = (id: string, group: string | null): Item => ({
  id,
  franchise: group === null ? null : franchise(group),
});
const group = (items: readonly Item[]) =>
  groupByFranchise(
    items,
    (entry) => entry.franchise,
    (entry) => entry.id,
  );

describe('groupByFranchise', () => {
  it('puts the seasons of one show together, where the first of them was', () => {
    const rows = group([item('a', null), item('s1', 'f'), item('b', null), item('s2', 'f')]);
    expect(rows.map((row) => row.key)).toEqual(['a', 'franchise-f', 'b']);
    const banner = rows[1];
    expect(banner?.kind).toBe('banner');
    expect(banner?.kind === 'banner' && banner.items.map((entry) => entry.id)).toEqual([
      's1',
      's2',
    ]);
  });

  it('leaves a lone member of a franchise as it is: one title is not a banner', () => {
    const rows = group([item('s1', 'f'), item('x', null)]);
    expect(rows.map((row) => row.kind)).toEqual(['one', 'one']);
  });

  it('keeps separate franchises apart and the order of everything else', () => {
    const rows = group([
      item('a1', 'a'),
      item('b1', 'b'),
      item('a2', 'a'),
      item('b2', 'b'),
      item('c', null),
    ]);
    expect(rows.map((row) => row.key)).toEqual(['franchise-a', 'franchise-b', 'c']);
  });

  it('does nothing to a list with no franchises', () => {
    const rows = group([item('a', null), item('b', null)]);
    expect(rows.map((row) => row.key)).toEqual(['a', 'b']);
    expect(group([])).toEqual([]);
  });
});

describe('franchiseSummary', () => {
  const info = (seasons: number | null, size: number): FranchiseInfo => ({
    ...franchise('f'),
    seasons,
    size,
  });
  it('says how many seasons and how many other titles', () => {
    expect(franchiseSummary(info(8, 24))).toBe('8 seasons · 16 movies, specials and spin-offs');
    expect(franchiseSummary(info(3, 4))).toBe('3 seasons · 1 movie, special or spin-off');
    expect(franchiseSummary(info(1, 1 + 1))).toBe('1 season · 1 movie, special or spin-off');
  });
  it('drops the second part when everything is a season', () => {
    expect(franchiseSummary(info(2, 2))).toBe('2 seasons');
  });
  it('falls back to the number of titles when the seasons are not counted', () => {
    expect(franchiseSummary(info(null, 24))).toBe('24 titles');
    expect(franchiseSummary(info(0, 3))).toBe('3 titles');
  });
});
