import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderMarkdown, syncPreviewToLine, getLineFromPreview } from '../core/preview.js';

let container;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  container.remove();
});

describe('renderMarkdown source-line attribution', () => {
  it('tags headings with data-source-line', () => {
    renderMarkdown('# Heading 1\n\n## Heading 2\n', '', container);
    const h1 = container.querySelector('h1');
    const h2 = container.querySelector('h2');
    expect(h1?.dataset.sourceLine).toBe('1');
    expect(h2?.dataset.sourceLine).toBe('3');
  });

  it('tags paragraphs with their source line', () => {
    renderMarkdown('para 1\n\npara 2\n\npara 3\n', '', container);
    const ps = container.querySelectorAll('p');
    expect(ps).toHaveLength(3);
    expect(ps[0].dataset.sourceLine).toBe('1');
    expect(ps[1].dataset.sourceLine).toBe('3');
    expect(ps[2].dataset.sourceLine).toBe('5');
  });

  it('tags code fences', () => {
    renderMarkdown('text\n\n```\ncode\n```\n', '', container);
    const pre = container.querySelector('pre');
    expect(pre?.dataset.sourceLine).toBe('3');
  });

  it('tags lists', () => {
    renderMarkdown('- item one\n- item two\n', '', container);
    const ul = container.querySelector('ul');
    expect(ul?.dataset.sourceLine).toBe('1');
  });

  it('tags table rows so sync has anchors inside a table', () => {
    renderMarkdown('| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n', '', container);
    const bodyRows = container.querySelectorAll('tbody tr[data-source-line]');
    // Each body row carries its own source line — the anchors that keep
    // editor⇄preview sync from drifting across a table.
    expect(bodyRows.length).toBe(2);
    expect(bodyRows[0].dataset.sourceLine).toBe('3');
    expect(bodyRows[1].dataset.sourceLine).toBe('4');
  });
});

// jsdom does not lay out elements, so we stub getBoundingClientRect — the
// container-relative source the sync now uses. Each element's viewport top is
// its intended content-space top minus the current scrollTop, and the container
// sits at viewport top 0; the sync recovers the content-space top exactly.
function stubRects(container, linesAndOffsets) {
  container.innerHTML = '';
  container.getBoundingClientRect = () => ({
    top: 0,
    left: 0,
    bottom: 0,
    right: 0,
    width: 0,
    height: 0,
  });
  for (const [line, top] of linesAndOffsets) {
    const div = document.createElement('div');
    div.dataset.sourceLine = String(line);
    div.getBoundingClientRect = () => ({
      top: top - container.scrollTop,
      left: 0,
      bottom: 0,
      right: 0,
      width: 0,
      height: 0,
    });
    container.appendChild(div);
  }
}

describe('syncPreviewToLine', () => {
  function setupElements(linesAndOffsets) {
    stubRects(container, linesAndOffsets);
    Object.defineProperty(container, 'scrollHeight', {
      value: 10000,
      configurable: true,
    });
    Object.defineProperty(container, 'clientHeight', {
      value: 500,
      configurable: true,
    });
  }

  it('scrolls to first element when line is at first source line', () => {
    setupElements([
      [1, 0],
      [5, 100],
      [10, 200],
    ]);
    syncPreviewToLine(container, 1);
    expect(container.scrollTop).toBe(0);
  });

  it('interpolates between two source-line elements', () => {
    setupElements([
      [1, 0],
      [5, 100],
      [10, 200],
    ]);
    // Line 3: between 1 and 5, halfway
    syncPreviewToLine(container, 3);
    expect(container.scrollTop).toBe(50);
  });

  it('snaps to a tagged line exactly', () => {
    setupElements([
      [1, 0],
      [5, 100],
      [10, 200],
    ]);
    syncPreviewToLine(container, 5);
    expect(container.scrollTop).toBe(100);
  });

  it('handles fractional line values', () => {
    setupElements([
      [1, 0],
      [5, 100],
    ]);
    // Line 2.5: 1.5 / 4 = 0.375 of the way
    syncPreviewToLine(container, 2.5);
    expect(container.scrollTop).toBeCloseTo(37.5, 1);
  });

  it('does nothing when no source-line elements exist', () => {
    container.innerHTML = '<div>no tags</div>';
    container.scrollTop = 99;
    syncPreviewToLine(container, 5);
    expect(container.scrollTop).toBe(99);
  });

  it('extrapolates past the last tagged element', () => {
    setupElements([
      [1, 0],
      [5, 100],
    ]);
    syncPreviewToLine(container, 10);
    expect(container.scrollTop).toBeGreaterThan(100);
  });

  it('returns early on null container', () => {
    expect(() => syncPreviewToLine(null, 5)).not.toThrow();
  });
});

describe('getLineFromPreview', () => {
  function setupElements(linesAndOffsets, scrollTop = 0) {
    stubRects(container, linesAndOffsets);
    container.scrollTop = scrollTop;
  }

  it('returns the first line when scrolled to top', () => {
    setupElements(
      [
        [1, 0],
        [5, 100],
        [10, 200],
      ],
      0,
    );
    expect(getLineFromPreview(container)).toBe(1);
  });

  it('returns interpolated line when scrolled between elements', () => {
    setupElements(
      [
        [1, 0],
        [5, 100],
        [10, 200],
      ],
      50,
    ); // halfway between line 1 and line 5
    expect(getLineFromPreview(container)).toBe(3);
  });

  it('snaps to a line when scrolled exactly to its element', () => {
    setupElements(
      [
        [1, 0],
        [5, 100],
        [10, 200],
      ],
      100,
    );
    expect(getLineFromPreview(container)).toBe(5);
  });

  it('returns last line when scrolled past the last element', () => {
    setupElements(
      [
        [1, 0],
        [5, 100],
        [10, 200],
      ],
      500,
    );
    expect(getLineFromPreview(container)).toBe(10);
  });

  it('returns null when no source-line elements exist', () => {
    container.innerHTML = '<div>no tags</div>';
    container.scrollTop = 50;
    expect(getLineFromPreview(container)).toBeNull();
  });

  it('returns null on null container', () => {
    expect(getLineFromPreview(null)).toBeNull();
  });

  it('uses container-relative geometry, not table-relative offsetTop', () => {
    // Simulate a table row: its offsetTop is measured from the <table> (a small
    // number), but its true position in the scroll content is far down. The old
    // code read offsetTop and mis-synced; the fix reads getBoundingClientRect.
    container.innerHTML = '';
    container.getBoundingClientRect = () => ({
      top: 0,
      left: 0,
      bottom: 0,
      right: 0,
      width: 0,
      height: 0,
    });
    const mk = (line, contentTop, misleadingOffsetTop) => {
      const div = document.createElement('div');
      div.dataset.sourceLine = String(line);
      Object.defineProperty(div, 'offsetTop', { value: misleadingOffsetTop, configurable: true });
      div.getBoundingClientRect = () => ({
        top: contentTop - container.scrollTop,
        left: 0,
        bottom: 0,
        right: 0,
        width: 0,
        height: 0,
      });
      container.appendChild(div);
    };
    mk(1, 0, 0);
    mk(5, 100, 0); // a "table row" far down (content top 100) but offsetTop 0
    mk(10, 200, 0);
    container.scrollTop = 100;
    // Correct answer uses content top (100 => line 5); offsetTop-based logic
    // would have wrongly treated all rows as top 0.
    expect(getLineFromPreview(container)).toBe(5);
  });
});
