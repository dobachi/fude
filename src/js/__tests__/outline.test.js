import { describe, it, expect, beforeEach } from 'vitest';
import { extractHeadings, initOutline, focusOutline } from '../core/outline.js';

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
