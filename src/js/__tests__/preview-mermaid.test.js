import { describe, it, expect } from 'vitest';
import {
  renderMarkdown,
  enhancePreview,
  setMermaidEnabled,
  isMermaidFile,
  renderPreview,
} from '../core/preview.js';

describe('isMermaidFile', () => {
  it('recognizes Mermaid file extensions (case-insensitive)', () => {
    for (const p of ['a.mmd', 'b.mermaid', 'X.MMD', 'dir/c.Mermaid']) {
      expect(isMermaidFile(p)).toBe(true);
    }
  });
  it('rejects non-Mermaid files', () => {
    for (const p of ['note.md', 'a.txt', 'diagram.puml', 'noext', '', null, undefined]) {
      expect(isMermaidFile(p)).toBe(false);
    }
  });
});

describe('renderPreview routing for Mermaid', () => {
  it('renders a .mmd file as Markdown when the extension is disabled', () => {
    setMermaidEnabled(false);
    const c = document.createElement('div');
    renderPreview('# Not a diagram', '', c, 'diagram.mmd');
    expect(c.querySelector('.mermaid-diagram')).toBeFalsy();
    expect(c.querySelector('h1')).toBeTruthy();
  });

  it('uses a diagram placeholder for a .mmd file when enabled', () => {
    setMermaidEnabled(true);
    const c = document.createElement('div');
    renderPreview('graph TD; A-->B;', '', c, 'diagram.mmd');
    // Synchronous placeholder is inserted before async engine load.
    expect(c.querySelector('.mermaid-diagram')).toBeTruthy();
    setMermaidEnabled(false);
  });
});

describe('preview Mermaid fence integration', () => {
  it('renders ```mermaid as code.language-mermaid', () => {
    const c = document.createElement('div');
    renderMarkdown('```mermaid\ngraph TD; A-->B;\n```\n', '', c);
    expect(c.querySelector('pre > code.language-mermaid')).toBeTruthy();
  });

  it('enhancePreview is a no-op when the extension is disabled', async () => {
    setMermaidEnabled(false);
    const c = document.createElement('div');
    renderMarkdown('```mermaid\ngraph TD; A-->B;\n```\n', '', c);
    const before = c.innerHTML;
    await enhancePreview(c);
    expect(c.innerHTML).toBe(before);
  });

  it('replaces the fence with a diagram placeholder when enabled', async () => {
    setMermaidEnabled(true);
    const c = document.createElement('div');
    renderMarkdown('```mermaid\ngraph TD; A-->B;\n```\n', '', c);
    await enhancePreview(c);
    // The <pre> is swapped for a .mermaid-diagram holder (async engine load
    // happens after; the placeholder is synchronous within the pass).
    expect(c.querySelector('.mermaid-diagram')).toBeTruthy();
    expect(c.querySelector('pre > code.language-mermaid')).toBeFalsy();
    setMermaidEnabled(false);
  });
});
