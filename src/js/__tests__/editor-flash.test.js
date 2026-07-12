import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flashLine } from '../core/editor.js';

// flashLine dispatches a decoration effect immediately and a clearing effect
// after a timeout. jsdom has no layout, so we drive the pure logic (line-start
// resolution, clamping, timed clear) with a mock EditorView that records the
// effects it is handed — same approach as editor-scroll.test.js.

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function mockView() {
  const dispatched = [];
  return {
    dispatched,
    state: { doc: { lines: 10, line: (n) => ({ from: (n - 1) * 5 }) } },
    dispatch: (tr) => dispatched.push(tr),
  };
}

describe('flashLine', () => {
  it('flashes the line-start position, then clears it after the timeout', () => {
    const view = mockView();
    flashLine(view, 3); // line 3 → from = (3-1)*5 = 10

    expect(view.dispatched).toHaveLength(1);
    // flashLine dispatches a single StateEffect (not an array).
    expect(view.dispatched[0].effects.value).toBe(10);

    vi.runAllTimers();

    expect(view.dispatched).toHaveLength(2);
    // The clearing effect carries a null value.
    expect(view.dispatched[1].effects.value).toBeNull();
  });

  it('clamps an out-of-range line to the last line', () => {
    const view = mockView();
    flashLine(view, 999); // clamps to line 10 → from = 45
    expect(view.dispatched[0].effects.value).toBe(45);
  });

  it('does not throw when the view is null', () => {
    expect(() => flashLine(null, 1)).not.toThrow();
  });

  it('swallows a dispatch error when the view is destroyed before the clear', () => {
    const view = mockView();
    let calls = 0;
    view.dispatch = () => {
      calls += 1;
      if (calls > 1) throw new Error('view destroyed');
    };
    flashLine(view, 1);
    expect(() => vi.runAllTimers()).not.toThrow();
    expect(calls).toBe(2);
  });
});
