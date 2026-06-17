import { describe, it, expect } from 'vitest';
import { getScroll, setScroll } from '../core/editor.js';

// getScroll/setScroll work against a CodeMirror EditorView, but the only methods
// they touch are scrollDOM, state.doc, lineBlockAtHeight/lineBlockAt. jsdom does
// not compute layout, so we drive the pure line<->pixel logic with mock views.

describe('getScroll', () => {
  it('captures the fractional top line alongside pixels', () => {
    const view = {
      scrollDOM: { scrollTop: 90, scrollLeft: 5 },
      state: { doc: { lineAt: () => ({ number: 6 }) } },
      lineBlockAtHeight: () => ({ from: 0, top: 80, bottom: 100 }),
    };
    const s = getScroll(view);
    expect(s.top).toBe(90);
    expect(s.left).toBe(5);
    // 6 + (90 - 80) / (100 - 80) = 6.5
    expect(s.line).toBeCloseTo(6.5, 5);
  });

  it('falls back to line 1 when layout measurement throws', () => {
    const view = {
      scrollDOM: { scrollTop: 0, scrollLeft: 0 },
      state: {
        doc: {
          lineAt: () => {
            throw new Error('no layout');
          },
        },
      },
      lineBlockAtHeight: () => {
        throw new Error('no layout');
      },
    };
    expect(getScroll(view).line).toBe(1);
  });
});

describe('setScroll', () => {
  function lineView() {
    return {
      scrollDOM: { scrollTop: 0, scrollLeft: 0 },
      state: { doc: { lines: 100, line: () => ({ from: 0 }) } },
      lineBlockAt: () => ({ top: 200, bottom: 220 }),
    };
  }

  it('prefers width-independent line-based restore when a line is given', () => {
    const view = lineView();
    setScroll(view, { top: 9999, left: 7, line: 10 });
    // scrollEditorToLine: block.top (200) + fraction (0) * height
    expect(view.scrollDOM.scrollTop).toBe(200);
    // horizontal scroll is still restored from pixels
    expect(view.scrollDOM.scrollLeft).toBe(7);
  });

  it('honors the fractional part of a line', () => {
    const view = lineView();
    setScroll(view, { line: 10.5 });
    // 200 + 0.5 * (220 - 200) = 210
    expect(view.scrollDOM.scrollTop).toBe(210);
  });

  it('falls back to pixel scrollTop when no line is present', () => {
    const view = { scrollDOM: { scrollTop: 0, scrollLeft: 0 } };
    setScroll(view, { top: 123, left: 4 });
    expect(view.scrollDOM.scrollTop).toBe(123);
    expect(view.scrollDOM.scrollLeft).toBe(4);
  });

  it('ignores null scroll and null view', () => {
    const view = { scrollDOM: { scrollTop: 5, scrollLeft: 5 } };
    setScroll(view, null);
    expect(view.scrollDOM.scrollTop).toBe(5);
    expect(() => setScroll(null, { line: 1 })).not.toThrow();
  });
});
