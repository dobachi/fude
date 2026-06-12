import { describe, it, expect } from 'vitest';
import markdownIt from 'markdown-it';
import {
  isQuartoFile,
  parseFrontMatter,
  renderFrontMatterHeader,
  parseCellInfo,
  applyQuartoExtensions,
} from '../features/quarto/quarto-md.js';

describe('isQuartoFile', () => {
  it('matches .qmd case-insensitively', () => {
    expect(isQuartoFile('/docs/report.qmd')).toBe(true);
    expect(isQuartoFile('NOTES.QMD')).toBe(true);
  });
  it('rejects everything else', () => {
    for (const p of ['readme.md', 'a.txt', 'noext', '', null, undefined]) {
      expect(isQuartoFile(p)).toBe(false);
    }
  });
});

describe('parseFrontMatter', () => {
  it('extracts top-level scalar keys, stripping quotes', () => {
    const meta = parseFrontMatter(
      ['title: "My Doc"', 'subtitle: A test', 'author: Jane', 'date: 2026-01-01'].join('\n'),
    );
    expect(meta).toEqual({
      title: 'My Doc',
      subtitle: 'A test',
      author: 'Jane',
      date: '2026-01-01',
    });
  });

  it('ignores nested/block keys and unknown keys', () => {
    const meta = parseFrontMatter(['title: T', 'format:', '  html:', '    toc: true'].join('\n'));
    expect(meta).toEqual({ title: 'T' });
  });

  it('returns {} for empty input', () => {
    expect(parseFrontMatter('')).toEqual({});
    expect(parseFrontMatter(null)).toEqual({});
  });
});

describe('renderFrontMatterHeader', () => {
  it('builds a title block with optional byline', () => {
    const html = renderFrontMatterHeader({
      title: 'My Doc',
      subtitle: 'Sub',
      author: 'Jane',
      date: '2026-01-01',
    });
    expect(html).toContain('quarto-title-block');
    expect(html).toContain('>My Doc</h1>');
    expect(html).toContain('Sub');
    expect(html).toContain('Jane · 2026-01-01');
  });

  it('returns empty string when there is no title', () => {
    expect(renderFrontMatterHeader({})).toBe('');
    expect(renderFrontMatterHeader({ author: 'Jane' })).toBe('');
  });

  it('escapes HTML in metadata', () => {
    const html = renderFrontMatterHeader({ title: '<script>x</script>' });
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
});

describe('parseCellInfo', () => {
  it('recognizes executable cells', () => {
    expect(parseCellInfo('{python}')).toEqual({ lang: 'python' });
    expect(parseCellInfo('{r}')).toEqual({ lang: 'r' });
    expect(parseCellInfo('{python echo=false}')).toEqual({ lang: 'python' });
  });
  it('rejects attributed display blocks and plain languages', () => {
    expect(parseCellInfo('{.python}')).toBeNull(); // Pandoc display block
    expect(parseCellInfo('python')).toBeNull(); // plain highlight hint
    expect(parseCellInfo('')).toBeNull();
    expect(parseCellInfo(null)).toBeNull();
  });
});

describe('applyQuartoExtensions (markdown-it integration)', () => {
  function makeMd() {
    let fm = null;
    const md = markdownIt();
    applyQuartoExtensions(md, {
      onFrontMatter: (raw) => {
        fm = raw;
      },
    });
    return { md, getFm: () => fm };
  }

  it('renders ::: {.callout-tip} as a styled callout with markdown body', () => {
    const { md } = makeMd();
    const html = md.render('::: {.callout-tip}\nUse **this**.\n:::\n');
    expect(html).toContain('class="callout callout-tip"');
    expect(html).toContain('class="callout-header"');
    expect(html).toContain('<strong>this</strong>'); // inner content parsed as md
  });

  it('uses an explicit title="…" on the callout when given', () => {
    const { md } = makeMd();
    const html = md.render('::: {.callout-note title="Heads up"}\nbody\n:::\n');
    expect(html).toContain('Heads up');
  });

  it('renders an executable cell as a labelled code cell (not executed)', () => {
    const { md } = makeMd();
    const html = md.render('```{python}\nprint(1)\n```\n');
    expect(html).toContain('class="quarto-cell"');
    expect(html).toContain('data-exec-lang="python"');
    expect(html).toContain('class="language-python"');
    expect(html).toContain('print(1)');
  });

  it('leaves a normal fenced code block untouched', () => {
    const { md } = makeMd();
    const html = md.render('```js\nconst x = 1;\n```\n');
    expect(html).not.toContain('quarto-cell');
    expect(html).toContain('language-js');
  });

  it('strips front matter from the body and reports it via callback', () => {
    const { md, getFm } = makeMd();
    const html = md.render('---\ntitle: Hello\n---\n\n# Body\n');
    expect(getFm()).toContain('title: Hello');
    expect(html).not.toContain('Hello');
    expect(html).toContain('Body');
  });
});
