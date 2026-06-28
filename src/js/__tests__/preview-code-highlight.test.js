import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  renderMarkdown,
  enhancePreview,
  setCodeHighlightEnabled,
  setPlantumlEnabled,
} from '../core/preview.js';

function container() {
  // Attach to the document: enhancePreview only writes back to connected
  // elements (it bails on stale nodes from a concurrent re-render).
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  setCodeHighlightEnabled(false);
  setPlantumlEnabled(false);
  document.body.innerHTML = '';
});

describe('preview code highlighting', () => {
  beforeEach(() => {
    setPlantumlEnabled(false);
  });

  it('leaves code blocks plain when the feature is disabled', async () => {
    setCodeHighlightEnabled(false);
    const el = container();
    renderMarkdown('```js\nconst x = 1;\n```\n', '', el);
    await enhancePreview(el);
    expect(el.querySelector('code .tok-keyword')).toBeNull();
    expect(el.querySelector('pre code').textContent).toContain('const x = 1;');
  });

  it('adds tok-* spans to code blocks when enabled', async () => {
    setCodeHighlightEnabled(true);
    const el = container();
    renderMarkdown('```js\nconst x = 1;\n```\n', '', el);
    await enhancePreview(el);
    const code = el.querySelector('pre code');
    expect(code.querySelector('.tok-keyword')).not.toBeNull();
    // Original text is preserved (highlighting only wraps it).
    expect(code.textContent).toContain('const x = 1;');
  });

  it('leaves unknown-language blocks untouched', async () => {
    setCodeHighlightEnabled(true);
    const el = container();
    renderMarkdown('```no-such-lang\nfoo bar\n```\n', '', el);
    await enhancePreview(el);
    const code = el.querySelector('pre code');
    expect(code.querySelector('span')).toBeNull();
    expect(code.textContent).toContain('foo bar');
  });

  it('does not syntax-highlight plantuml fences', async () => {
    setCodeHighlightEnabled(true);
    setPlantumlEnabled(false); // adapter off → block stays as plain code
    const el = container();
    renderMarkdown('```plantuml\n@startuml\nA -> B\n@enduml\n```\n', '', el);
    await enhancePreview(el);
    const code = el.querySelector('pre code.language-plantuml');
    expect(code).not.toBeNull();
    expect(code.querySelector('.tok-keyword')).toBeNull();
  });
});
