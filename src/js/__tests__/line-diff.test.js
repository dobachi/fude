import { describe, it, expect } from 'vitest';
import { diffLines, diffStats } from '../core/line-diff.js';

describe('diffLines', () => {
  it('marks all lines equal for identical text', () => {
    const d = diffLines('a\nb\nc', 'a\nb\nc');
    expect(d.every((x) => x.type === 'equal')).toBe(true);
    expect(d.map((x) => x.value)).toEqual(['a', 'b', 'c']);
  });

  it('detects an added line', () => {
    const d = diffLines('a\nc', 'a\nb\nc');
    expect(d).toEqual([
      { type: 'equal', value: 'a' },
      { type: 'add', value: 'b' },
      { type: 'equal', value: 'c' },
    ]);
  });

  it('detects a removed line', () => {
    const d = diffLines('a\nb\nc', 'a\nc');
    expect(d).toEqual([
      { type: 'equal', value: 'a' },
      { type: 'del', value: 'b' },
      { type: 'equal', value: 'c' },
    ]);
  });

  it('detects a changed line as del + add', () => {
    const d = diffLines('hello\nworld', 'hello\nthere');
    expect(d).toContainEqual({ type: 'del', value: 'world' });
    expect(d).toContainEqual({ type: 'add', value: 'there' });
    expect(d[0]).toEqual({ type: 'equal', value: 'hello' });
  });

  it('handles empty old (all added) and empty new (all removed)', () => {
    expect(diffLines('', 'x\ny')).toEqual([
      { type: 'add', value: 'x' },
      { type: 'add', value: 'y' },
    ]);
    expect(diffLines('x\ny', '')).toEqual([
      { type: 'del', value: 'x' },
      { type: 'del', value: 'y' },
    ]);
  });

  it('reconstructs both sides from the diff', () => {
    const oldT = 'one\ntwo\nthree\nfour';
    const newT = 'one\nTWO\nthree\nfour\nfive';
    const d = diffLines(oldT, newT);
    const back = (skip) =>
      d
        .filter((x) => x.type !== skip)
        .map((x) => x.value)
        .join('\n');
    expect(back('add')).toBe(oldT); // drop additions → original
    expect(back('del')).toBe(newT); // drop deletions → new
  });
});

describe('diffStats', () => {
  it('counts additions and removals', () => {
    const d = diffLines('a\nb\nc', 'a\nx\nc\nd');
    expect(diffStats(d)).toEqual({ added: 2, removed: 1 });
  });
});
