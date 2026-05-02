import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderMarkdown, syncPreviewToLine } from '../core/preview.js';

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
});

describe('syncPreviewToLine', () => {
  // jsdom does not lay out elements, so we stub offsetTop and scrollHeight
  function setupElements(linesAndOffsets) {
    container.innerHTML = '';
    for (const [line, top] of linesAndOffsets) {
      const div = document.createElement('div');
      div.dataset.sourceLine = String(line);
      Object.defineProperty(div, 'offsetTop', { value: top, configurable: true });
      container.appendChild(div);
    }
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
    setupElements([[1, 0], [5, 100], [10, 200]]);
    syncPreviewToLine(container, 1);
    expect(container.scrollTop).toBe(0);
  });

  it('interpolates between two source-line elements', () => {
    setupElements([[1, 0], [5, 100], [10, 200]]);
    // Line 3: between 1 and 5, halfway
    syncPreviewToLine(container, 3);
    expect(container.scrollTop).toBe(50);
  });

  it('snaps to a tagged line exactly', () => {
    setupElements([[1, 0], [5, 100], [10, 200]]);
    syncPreviewToLine(container, 5);
    expect(container.scrollTop).toBe(100);
  });

  it('handles fractional line values', () => {
    setupElements([[1, 0], [5, 100]]);
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
    setupElements([[1, 0], [5, 100]]);
    syncPreviewToLine(container, 10);
    expect(container.scrollTop).toBeGreaterThan(100);
  });

  it('returns early on null container', () => {
    expect(() => syncPreviewToLine(null, 5)).not.toThrow();
  });
});
