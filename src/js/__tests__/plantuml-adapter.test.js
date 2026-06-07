import { describe, it, expect } from 'vitest';
import { sanitizeSvg } from '../features/plantuml/adapter.js';

const SVG = (inner) => `<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;

describe('sanitizeSvg', () => {
  it('keeps normal svg content', () => {
    const out = sanitizeSvg(SVG('<rect width="10" height="10"></rect>'));
    expect(out).toContain('rect');
    expect(out).toContain('width="10"');
  });

  it('removes <script> elements', () => {
    const out = sanitizeSvg(SVG('<script>alert(1)</script><rect></rect>'));
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
    expect(out).toContain('rect');
  });

  it('strips on* event attributes', () => {
    const out = sanitizeSvg(SVG('<rect onclick="evil()"></rect>'));
    expect(out.toLowerCase()).not.toContain('onclick');
    expect(out).toContain('rect');
  });

  it('removes javascript: hrefs', () => {
    const out = sanitizeSvg(SVG('<a href="javascript:evil()"><rect></rect></a>'));
    expect(out.toLowerCase()).not.toContain('javascript:');
  });

  it('keeps safe hrefs', () => {
    const out = sanitizeSvg(SVG('<a href="https://example.com/"><rect></rect></a>'));
    expect(out).toContain('https://example.com/');
  });
});
