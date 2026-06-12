import { describe, it, expect } from 'vitest';
import { renderPreview, renderQuartoMarkdown } from '../core/preview.js';

describe('preview routing for .qmd', () => {
  it('renders a .qmd file with Quarto extensions (callout + cell + title block)', () => {
    const c = document.createElement('div');
    const doc = [
      '---',
      'title: My Report',
      '---',
      '',
      '# Intro',
      '',
      '::: {.callout-warning}',
      'Be careful.',
      ':::',
      '',
      '```{python}',
      'print("hi")',
      '```',
      '',
    ].join('\n');
    renderPreview(doc, '', c, 'report.qmd');

    expect(c.querySelector('.quarto-title-block')).toBeTruthy();
    expect(c.querySelector('.callout.callout-warning')).toBeTruthy();
    expect(c.querySelector('pre.quarto-cell[data-exec-lang="python"]')).toBeTruthy();
    // The title block carries the title; the body keeps its own "Intro" heading.
    const headings = [...c.querySelectorAll('h1')].map((h) => h.textContent);
    expect(headings).toContain('My Report'); // from the front-matter title block
    expect(headings).toContain('Intro'); // body heading
    // The raw YAML must not leak into the rendered body.
    expect(c.textContent).not.toContain('title: My Report');
  });

  it('does NOT apply Quarto extensions to a .md file', () => {
    const c = document.createElement('div');
    renderPreview('::: {.callout-note}\nhi\n:::\n', '', c, 'note.md');
    expect(c.querySelector('.callout')).toBeFalsy();
  });

  it('renderQuartoMarkdown is a no-op without a container', () => {
    expect(() => renderQuartoMarkdown('# x', '', null)).not.toThrow();
  });

  it('honours an explicit heading id from attrs and still auto-slugs others', () => {
    const c = document.createElement('div');
    renderPreview('# Introduction {#sec-intro .unnumbered}\n\n## Plain Heading\n', '', c, 'a.qmd');

    const h1 = c.querySelector('h1');
    expect(h1.id).toBe('sec-intro'); // explicit id preserved (not overwritten by slug)
    expect(h1.classList.contains('unnumbered')).toBe(true);
    expect(h1.textContent).toBe('Introduction'); // braces gone

    const h2 = c.querySelector('h2');
    expect(h2.id).toBe('plain-heading'); // auto-slug still applied where no explicit id
  });
});
