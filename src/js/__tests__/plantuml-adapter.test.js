import { describe, it, expect } from 'vitest';
import { sanitizeSvg, renderPlantUML } from '../features/plantuml/adapter.js';

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

describe('renderPlantUML の戻り値', () => {
  // Regression: the cache held the resolved SVG string, so the SECOND render of
  // an unchanged diagram returned a plain string and the preview's
  // `renderPlantUML(...).then(...)` threw "then is not a function". The diagram
  // was then stuck on its "⏳ PlantUML…" placeholder, and because the error
  // escaped the diagram pass, the Mermaid and syntax-highlight passes queued
  // behind it never ran either. Observed live: of 13 renders, the Mermaid and
  // highlight passes completed exactly once each.
  const SRC = '@startuml\nA -> B\n@enduml';

  it('常に Promise を返す（1回目も2回目も）', async () => {
    const first = renderPlantUML(SRC);
    expect(typeof first.then).toBe('function');
    expect(typeof first.catch).toBe('function');
    // 拡張未導入の環境では reject する。ここでは型だけを見る
    await first.catch(() => {});

    const second = renderPlantUML(SRC);
    expect(typeof second.then).toBe('function');
    expect(typeof second.catch).toBe('function');
    await second.catch(() => {});
  });
});
