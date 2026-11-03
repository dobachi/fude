import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  extractHeadings,
  initOutline,
  focusOutline,
  updateOutline,
  findActiveHeadingIndex,
  pickOutlineLine,
  setActiveOutlineLine,
  getActiveOutlineLine,
  clearOutline,
} from '../core/outline.js';

describe('extractHeadings', () => {
  it('returns empty array for empty/falsy input', () => {
    expect(extractHeadings('')).toEqual([]);
    expect(extractHeadings(null)).toEqual([]);
    expect(extractHeadings(undefined)).toEqual([]);
  });

  it('extracts ATX headings with level and 1-based line number', () => {
    const text = ['# Title', '', '## Section A', 'body', '### Sub', '', '#### Deep'].join('\n');
    expect(extractHeadings(text)).toEqual([
      { level: 1, text: 'Title', line: 1 },
      { level: 2, text: 'Section A', line: 3 },
      { level: 3, text: 'Sub', line: 5 },
      { level: 4, text: 'Deep', line: 7 },
    ]);
  });

  it('strips optional trailing #s', () => {
    expect(extractHeadings('## Section ##')).toEqual([{ level: 2, text: 'Section', line: 1 }]);
    expect(extractHeadings('### Closed ###  ')).toEqual([{ level: 3, text: 'Closed', line: 1 }]);
  });

  it('requires whitespace after the hashes', () => {
    expect(extractHeadings('#NoSpace')).toEqual([]);
    expect(extractHeadings('# WithSpace')).toEqual([{ level: 1, text: 'WithSpace', line: 1 }]);
  });

  it('ignores headings inside fenced code blocks (```)', () => {
    const text = ['# Outside', '```', '# inside-fence', '## also-inside', '```', '## After'].join(
      '\n',
    );
    expect(extractHeadings(text)).toEqual([
      { level: 1, text: 'Outside', line: 1 },
      { level: 2, text: 'After', line: 6 },
    ]);
  });

  it('handles ~~~ fenced code blocks', () => {
    const text = ['~~~', '# inside', '~~~', '# outside'].join('\n');
    expect(extractHeadings(text)).toEqual([{ level: 1, text: 'outside', line: 4 }]);
  });

  it('matches fence type — ``` does not close a ~~~ block', () => {
    const text = ['~~~', '```', '# still-inside', '~~~', '# real'].join('\n');
    expect(extractHeadings(text)).toEqual([{ level: 1, text: 'real', line: 5 }]);
  });

  it('caps heading level at 6 (####### is not a heading)', () => {
    expect(extractHeadings('####### Too Many')).toEqual([]);
  });

  it('allows up to three leading spaces of indentation', () => {
    expect(extractHeadings('   ## Indented')).toEqual([{ level: 2, text: 'Indented', line: 1 }]);
    expect(extractHeadings('    ## Over')).toEqual([]);
  });
});

describe('focusOutline', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="outline-list" tabindex="-1"></div>';
  });

  it('moves focus to the outline container', () => {
    const ol = document.getElementById('outline-list');
    initOutline(ol, {});
    focusOutline();
    expect(document.activeElement).toBe(ol);
  });

  it('does not throw when the outline container is absent', () => {
    document.body.innerHTML = '';
    expect(() => focusOutline()).not.toThrow();
  });
});

describe('outline keyboard navigation', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="outline-list" tabindex="-1"></div>';
  });

  it('focusOutline focuses the first heading; arrows move; Enter jumps', () => {
    const ol = document.getElementById('outline-list');
    const onJump = vi.fn();
    initOutline(ol, { onJump });
    updateOutline(['# A', '## B', '## C'].join('\n'));

    const items = ol.querySelectorAll('.outline-item');
    expect(items.length).toBe(3);
    expect(items[0].tabIndex).toBe(-1);

    focusOutline();
    expect(document.activeElement).toBe(items[0]);

    ol.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(items[1]);

    ol.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onJump).toHaveBeenCalledWith(2); // '## B' is on line 2
  });
});

describe('findActiveHeadingIndex', () => {
  const hs = [{ line: 3 }, { line: 10 }, { line: 20 }];

  it('returns -1 when there are no headings', () => {
    expect(findActiveHeadingIndex([], 5)).toBe(-1);
    expect(findActiveHeadingIndex(null, 5)).toBe(-1);
  });

  it('falls back to the first heading above every heading (preamble)', () => {
    expect(findActiveHeadingIndex(hs, 1)).toBe(0);
    expect(findActiveHeadingIndex(hs, 2.9)).toBe(0);
  });

  it('picks the last heading at or before the line', () => {
    expect(findActiveHeadingIndex(hs, 3)).toBe(0); // on the heading itself
    expect(findActiveHeadingIndex(hs, 9.99)).toBe(0);
    expect(findActiveHeadingIndex(hs, 10)).toBe(1);
    expect(findActiveHeadingIndex(hs, 15.5)).toBe(1); // fractional line
    expect(findActiveHeadingIndex(hs, 20)).toBe(2);
    expect(findActiveHeadingIndex(hs, 9999)).toBe(2); // past the end
  });
});

describe('pickOutlineLine', () => {
  it('follows the cursor in editor and split modes, ignoring the preview', () => {
    expect(pickOutlineLine({ viewMode: 'editor', cursorLine: 7, previewTopLine: 40 })).toBe(7);
    expect(pickOutlineLine({ viewMode: 'split', cursorLine: 7, previewTopLine: 40 })).toBe(7);
  });

  it('follows the preview top line in preview-only mode', () => {
    expect(pickOutlineLine({ viewMode: 'preview', cursorLine: 7, previewTopLine: 40.5 })).toBe(
      40.5,
    );
  });

  it('falls back to the cursor while the preview has no line yet', () => {
    expect(pickOutlineLine({ viewMode: 'preview', cursorLine: 7, previewTopLine: null })).toBe(7);
    expect(pickOutlineLine({ viewMode: 'preview', cursorLine: 7, previewTopLine: NaN })).toBe(7);
  });

  it('falls back to line 1 when nothing is known', () => {
    expect(pickOutlineLine({ viewMode: 'editor' })).toBe(1);
    expect(pickOutlineLine({ viewMode: 'preview' })).toBe(1);
    expect(pickOutlineLine()).toBe(1);
  });
});

describe('outline active highlight', () => {
  let ol;
  const DOC = ['intro', '# A', 'a body', '## B', 'b body', '## C'].join('\n');
  const activeTexts = () =>
    Array.from(ol.querySelectorAll('.outline-item.active'), (el) => el.textContent);

  beforeEach(() => {
    document.body.innerHTML = '<div id="outline-list" tabindex="-1"></div>';
    ol = document.getElementById('outline-list');
    initOutline(ol, {});
    clearOutline();
  });

  it('highlights the first heading by default, even above it (preamble)', () => {
    updateOutline(DOC);
    expect(activeTexts()).toEqual(['A']);
    setActiveOutlineLine(1); // 'intro' line, above '# A'
    expect(activeTexts()).toEqual(['A']);
  });

  it('moves the single highlight with the line', () => {
    updateOutline(DOC);
    setActiveOutlineLine(5);
    expect(activeTexts()).toEqual(['B']);
    setActiveOutlineLine(6);
    expect(activeTexts()).toEqual(['C']);
    setActiveOutlineLine(2);
    expect(activeTexts()).toEqual(['A']);
  });

  it('keeps the highlight across a re-render (typing rebuilds the list)', () => {
    updateOutline(DOC);
    setActiveOutlineLine(5);
    updateOutline(DOC + '\nmore text');
    expect(activeTexts()).toEqual(['B']);
  });

  it('re-resolves against new headings after a re-render', () => {
    updateOutline(DOC);
    setActiveOutlineLine(5); // in B
    // A heading inserted above shifts B down; line 5 now falls in the new one.
    updateOutline(['intro', '# A', '## New', 'x', 'y', '## B'].join('\n'));
    expect(activeTexts()).toEqual(['New']);
  });

  it('ignores a non-numeric line and keeps the previous one', () => {
    updateOutline(DOC);
    setActiveOutlineLine(5);
    setActiveOutlineLine(NaN);
    setActiveOutlineLine(undefined);
    expect(getActiveOutlineLine()).toBe(5);
    expect(activeTexts()).toEqual(['B']);
  });

  it('clearOutline resets to the top for the next document', () => {
    updateOutline(DOC);
    setActiveOutlineLine(6);
    clearOutline();
    expect(getActiveOutlineLine()).toBe(1);
    updateOutline(DOC);
    expect(activeTexts()).toEqual(['A']);
  });

  it('focusOutline lands on the highlighted heading', () => {
    updateOutline(DOC);
    setActiveOutlineLine(5);
    focusOutline();
    expect(document.activeElement.textContent).toBe('B');
  });

  it('does nothing for a document without headings', () => {
    updateOutline('just text');
    expect(() => setActiveOutlineLine(3)).not.toThrow();
    expect(activeTexts()).toEqual([]);
  });
});
