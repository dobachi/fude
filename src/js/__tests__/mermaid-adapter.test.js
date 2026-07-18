import { describe, it, expect, vi } from 'vitest';
import {
  sanitizeMermaidSvg,
  currentMermaidTheme,
  memoizeRender,
  renderMermaid,
} from '../features/mermaid/adapter.js';

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

describe('memoizeRender', () => {
  // Regression: the cache used to hold the resolved SVG string, so a second
  // render of the same diagram returned a string and the caller's
  // `renderMermaid(text).then(...)` threw "then is not a function".
  it('returns a promise on a cache hit, not the resolved value', async () => {
    const cache = new Map();
    const produce = () => Promise.resolve('<svg/>');
    await memoizeRender(cache, 'k', produce);

    const second = memoizeRender(cache, 'k', produce);
    expect(typeof second.then).toBe('function');
    await expect(second).resolves.toBe('<svg/>');
  });

  it('runs the producer once for repeated keys', async () => {
    const cache = new Map();
    const produce = vi.fn(() => Promise.resolve('<svg/>'));
    await memoizeRender(cache, 'k', produce);
    await memoizeRender(cache, 'k', produce);
    expect(produce).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight render between concurrent calls', async () => {
    const cache = new Map();
    const produce = vi.fn(() => Promise.resolve('<svg/>'));
    const a = memoizeRender(cache, 'k', produce);
    const b = memoizeRender(cache, 'k', produce);
    expect(a).toBe(b);
    expect(produce).toHaveBeenCalledTimes(1);
    await a;
  });

  it('keys renders separately', async () => {
    const cache = new Map();
    const produce = vi.fn((v) => Promise.resolve(v));
    await memoizeRender(cache, 'a', () => produce('A'));
    await memoizeRender(cache, 'b', () => produce('B'));
    expect(produce).toHaveBeenCalledTimes(2);
    await expect(cache.get('a')).resolves.toBe('A');
    await expect(cache.get('b')).resolves.toBe('B');
  });

  it('does not cache failures, so a later attempt can retry', async () => {
    const cache = new Map();
    const produce = vi
      .fn()
      .mockRejectedValueOnce(new Error('engine missing'))
      .mockResolvedValueOnce('<svg/>');

    await expect(memoizeRender(cache, 'k', produce)).rejects.toThrow('engine missing');
    expect(cache.has('k')).toBe(false);
    await expect(memoizeRender(cache, 'k', produce)).resolves.toBe('<svg/>');
  });
});

describe('renderMermaid の戻り値', () => {
  // Engine-independent contract check: whatever happens downstream (here the
  // extension isn't installed, so it rejects), the caller must always get a
  // thenable — that is exactly what the reported crash violated.
  it('常に Promise を返す（描画に失敗する場合も）', async () => {
    const p = renderMermaid('graph TD; A-->B');
    expect(typeof p.then).toBe('function');
    expect(typeof p.catch).toBe('function');
    await p.catch(() => {}); // 拡張未導入の環境では reject する。ここでは型だけ見る
  });
});
