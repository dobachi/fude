import { describe, it, expect } from 'vitest';
import {
  renderMarkdown,
  enhancePreview,
  setPlantumlEnabled,
  isPlantumlFile,
  renderPreview,
} from '../core/preview.js';

describe('isPlantumlFile', () => {
  it('recognizes PlantUML file extensions (case-insensitive)', () => {
    for (const p of ['a.puml', 'b.plantuml', 'c.uml', 'd.iuml', 'e.pu', 'f.wsd', 'X.PUML']) {
      expect(isPlantumlFile(p)).toBe(true);
    }
  });
  it('rejects non-PlantUML files', () => {
    for (const p of ['note.md', 'a.txt', 'noext', '', null, undefined]) {
      expect(isPlantumlFile(p)).toBe(false);
    }
  });
});

describe('renderPreview routing', () => {
  it('renders a .md file as Markdown', () => {
    setPlantumlEnabled(true);
    const c = document.createElement('div');
    renderPreview('# Title', '', c, 'note.md');
    expect(c.querySelector('h1')).toBeTruthy();
    setPlantumlEnabled(false);
  });

  it('renders a .puml file as Markdown when the extension is disabled', () => {
    setPlantumlEnabled(false);
    const c = document.createElement('div');
    renderPreview('# Not a diagram', '', c, 'diagram.puml');
    // Disabled => no diagram placeholder, falls back to Markdown.
    expect(c.querySelector('.puml-diagram')).toBeFalsy();
    expect(c.querySelector('h1')).toBeTruthy();
  });

  it('uses a diagram placeholder for a .puml file when enabled', () => {
    setPlantumlEnabled(true);
    const c = document.createElement('div');
    renderPreview('@startuml\nA->B\n@enduml', '', c, 'diagram.puml');
    // Synchronous placeholder is inserted before async engine load.
    expect(c.querySelector('.puml-diagram')).toBeTruthy();
    setPlantumlEnabled(false);
  });
});

describe('preview PlantUML fence integration', () => {
  it('renders ```plantuml as code.language-plantuml', () => {
    const c = document.createElement('div');
    renderMarkdown('```plantuml\nAlice -> Bob\n```\n', '', c);
    expect(c.querySelector('pre > code.language-plantuml')).toBeTruthy();
  });

  it('enhancePreview is a no-op when the extension is disabled', async () => {
    setPlantumlEnabled(false);
    const c = document.createElement('div');
    renderMarkdown('```plantuml\nAlice -> Bob\n```\n', '', c);
    const before = c.innerHTML;
    await enhancePreview(c);
    expect(c.innerHTML).toBe(before);
  });

  it('does nothing when there are no plantuml blocks even if enabled', async () => {
    setPlantumlEnabled(true);
    const c = document.createElement('div');
    renderMarkdown('# Hello\n\nplain text\n', '', c);
    const before = c.innerHTML;
    await enhancePreview(c);
    expect(c.innerHTML).toBe(before);
    setPlantumlEnabled(false);
  });
});
