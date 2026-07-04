import { describe, it, expect } from 'vitest';
import { sanitizeMermaidSvg, currentMermaidTheme } from '../features/mermaid/adapter.js';

const SVG = (inner) => `<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;

describe('sanitizeMermaidSvg', () => {
  it('keeps normal svg content', () => {
    const out = sanitizeMermaidSvg(SVG('<rect width="10" height="10"></rect>'));
    expect(out).toContain('rect');
    expect(out).toContain('width="10"');
  });

  it('removes <script> elements', () => {
    const out = sanitizeMermaidSvg(SVG('<script>alert(1)</script><rect></rect>'));
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
    expect(out).toContain('rect');
  });

  it('strips on* event attributes', () => {
    const out = sanitizeMermaidSvg(SVG('<rect onclick="evil()"></rect>'));
    expect(out.toLowerCase()).not.toContain('onclick');
    expect(out).toContain('rect');
  });

  it('removes javascript: hrefs', () => {
    const out = sanitizeMermaidSvg(SVG('<a href="javascript:evil()"><rect></rect></a>'));
    expect(out.toLowerCase()).not.toContain('javascript:');
  });

  it('keeps <foreignObject> (Mermaid uses it for labels)', () => {
    const out = sanitizeMermaidSvg(
      SVG('<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">Label</div></foreignObject>'),
    );
    expect(out).toContain('foreignObject');
    expect(out).toContain('Label');
  });
});

describe('currentMermaidTheme', () => {
  it('maps the app data-theme to a Mermaid theme name', () => {
    const root = document.documentElement;
    const prev = root.getAttribute('data-theme');

    root.setAttribute('data-theme', 'dark');
    expect(currentMermaidTheme()).toBe('dark');

    root.setAttribute('data-theme', 'light');
    expect(currentMermaidTheme()).toBe('default');

    if (prev === null) root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', prev);
  });
});
