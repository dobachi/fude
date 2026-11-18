import { describe, it, expect, afterEach } from 'vitest';
import {
  computeSectionNumbers,
  numberingBaseLevel,
  applySectionNumbers,
} from '../core/section-numbers.js';
import { renderMarkdown, setSectionNumbersEnabled } from '../core/preview.js';

describe('numberingBaseLevel', () => {
  it('is null for a document without headings', () => {
    expect(numberingBaseLevel([])).toBeNull();
  });

  it('is the shallowest level when it occurs more than once', () => {
    expect(numberingBaseLevel([1, 2, 1, 2])).toBe(1);
    expect(numberingBaseLevel([2, 3, 2])).toBe(2);
  });

  it('skips a lone leading title', () => {
    expect(numberingBaseLevel([1, 2, 3, 2])).toBe(2);
    // The level after the title need not be title+1.
    expect(numberingBaseLevel([1, 3, 3])).toBe(3);
  });

  it('takes only a # heading as a title', () => {
    expect(numberingBaseLevel([2, 3, 3])).toBe(2);
  });

  it('does not treat a lone # heading as a title when it is not first', () => {
    expect(numberingBaseLevel([2, 1, 2])).toBe(1);
  });

  it('numbers a single heading rather than calling it a title', () => {
    expect(numberingBaseLevel([2])).toBe(2);
  });
});

describe('computeSectionNumbers', () => {
  it('returns nothing for no headings', () => {
    expect(computeSectionNumbers([])).toEqual([]);
  });

  it('numbers nested sections hierarchically', () => {
    expect(computeSectionNumbers([1, 2, 2, 3, 3, 1, 2])).toEqual([
      '1',
      '1.1',
      '1.2',
      '1.2.1',
      '1.2.2',
      '2',
      '2.1',
    ]);
  });

  it('resets deeper counters when going back up', () => {
    expect(computeSectionNumbers([2, 3, 4, 2, 3, 4])).toEqual([
      '1',
      '1.1',
      '1.1.1',
      '2',
      '2.1',
      '2.1.1',
    ]);
  });

  it('leaves the title unnumbered and numbers the sections from 1', () => {
    expect(computeSectionNumbers([1, 2, 3, 2])).toEqual([null, '1', '1.1', '2']);
  });

  it('fills skipped levels with 0', () => {
    expect(computeSectionNumbers([2, 4, 4, 3])).toEqual(['1', '1.0.1', '1.0.2', '1.1']);
  });

  it('fills skipped levels with 0 when the document starts deep', () => {
    expect(computeSectionNumbers([3, 2, 3])).toEqual(['0.1', '1', '1.1']);
  });

  it('keeps many-digit numbers distinct', () => {
    const levels = [2, ...Array(12).fill(3)];
    const nums = computeSectionNumbers(levels);
    expect(nums.at(-1)).toBe('1.12');
    expect(new Set(nums).size).toBe(nums.length);
  });
});

describe('applySectionNumbers', () => {
  function container(html) {
    const c = document.createElement('div');
    c.innerHTML = html;
    return c;
  }

  it('sets data-section-number on top-level headings without touching their text', () => {
    const c = container('<h1 id="t">Title</h1><h2 id="a">A</h2><p>x</p><h3>B</h3>');
    applySectionNumbers(c, true);
    const [h1, h2, h3] = c.querySelectorAll('h1, h2, h3');
    expect(h1.hasAttribute('data-section-number')).toBe(false);
    expect(h2.getAttribute('data-section-number')).toBe('1');
    expect(h3.getAttribute('data-section-number')).toBe('1.1');
    expect(h2.textContent).toBe('A');
    expect(h2.id).toBe('a');
  });

  it('ignores headings nested inside other blocks', () => {
    const c = container(
      '<h2>A</h2><blockquote><h2>quoted</h2></blockquote><header><h1>front matter</h1></header><h2>B</h2>',
    );
    applySectionNumbers(c, true);
    expect(c.querySelector('blockquote h2').hasAttribute('data-section-number')).toBe(false);
    expect(c.querySelector('header h1').hasAttribute('data-section-number')).toBe(false);
    const top = [...c.children].filter((el) => el.tagName === 'H2');
    expect(top.map((h) => h.getAttribute('data-section-number'))).toEqual(['1', '2']);
  });

  it('removes the numbers when disabled', () => {
    const c = container('<h2>A</h2><h2>B</h2>');
    applySectionNumbers(c, true);
    applySectionNumbers(c, false);
    expect(c.querySelector('[data-section-number]')).toBeNull();
  });

  it('tolerates a missing container', () => {
    expect(() => applySectionNumbers(null, true)).not.toThrow();
  });
});

describe('preview rendering with section numbers', () => {
  afterEach(() => setSectionNumbersEnabled(false));

  const numbers = (c) =>
    [...c.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => h.getAttribute('data-section-number'));

  it('adds no numbers while the setting is off', () => {
    const c = document.createElement('div');
    renderMarkdown('## A\n\n## B\n', '', c);
    expect(c.querySelector('[data-section-number]')).toBeNull();
  });

  it('numbers headings when enabled', () => {
    setSectionNumbersEnabled(true);
    const c = document.createElement('div');
    renderMarkdown('# Title\n\n## A\n\n### A1\n\n## B\n', '', c);
    expect(numbers(c)).toEqual([null, '1', '1.1', '2']);
  });

  it('renumbers reused blocks when a heading is inserted above them', () => {
    setSectionNumbersEnabled(true);
    const c = document.createElement('div');
    renderMarkdown('## A\n\ntext\n\n## B\n', '', c);
    const bEl = c.querySelectorAll('h2')[1];
    expect(bEl.getAttribute('data-section-number')).toBe('2');

    // Incremental render: the "## B" block is unchanged and reused.
    renderMarkdown('## A\n\ntext\n\n## New\n\n## B\n', '', c);
    expect(numbers(c)).toEqual(['1', '2', '3']);
    expect(c.querySelectorAll('h2')[2]).toBe(bEl);
  });

  it('drops the numbers on re-render after being switched off', () => {
    setSectionNumbersEnabled(true);
    const c = document.createElement('div');
    renderMarkdown('## A\n\n## B\n', '', c);
    setSectionNumbersEnabled(false);
    renderMarkdown('## A\n\n## B\n', '', c);
    expect(c.querySelector('[data-section-number]')).toBeNull();
  });
});
