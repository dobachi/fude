import { describe, it, expect } from 'vitest';
import { renderMarkdown, enhancePreview, setPlantumlEnabled } from '../core/preview.js';

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
