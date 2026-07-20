import { describe, it, expect, vi } from 'vitest';
import { createPrinter, langForPath } from '../features/print/print.js';

// jsdom provides document; iframe load/print won't fire, so we inject a fake
// `printDocument` sink and assert the orchestration around it.

function makePrinter(over = {}) {
  const printed = [];
  const errors = [];
  const printer = createPrinter({
    renderPreview: over.renderPreview,
    printDocument: (html) => {
      printed.push(html);
      return Promise.resolve();
    },
    onError: (m) => errors.push(m),
    dirname: (p) => (p ? p.replace(/\/[^/]*$/, '') : ''),
    cssHref: 'style.css',
    timeoutMs: over.timeoutMs ?? 50,
  });
  return { printer, printed, errors };
}

describe('createPrinter.printPreview', () => {
  it('renders into an offscreen node, awaits it, then prints the snapshot', async () => {
    const renderPreview = vi.fn((content, basePath, container) => {
      // simulate async enhancement finishing after a tick
      return new Promise((res) => {
        setTimeout(() => {
          container.innerHTML = `<h1>${content}</h1><svg data-diagram></svg>`;
          res();
        }, 5);
      });
    });
    const { printer, printed, errors } = makePrinter({ renderPreview });

    await printer.printPreview({ content: 'Hello', path: '/home/u/a.md', name: 'a.md' });

    expect(renderPreview).toHaveBeenCalledOnce();
    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain('<h1>Hello</h1>');
    expect(printed[0]).toMatch(/<svg data-diagram/);
    expect(printed[0]).toContain('<title>a.md</title>');
    expect(errors).toHaveLength(0);
  });

  it('waits for enhancement: snapshot reflects post-await DOM, not the placeholder', async () => {
    let container;
    const renderPreview = vi.fn((content, basePath, c) => {
      container = c;
      c.innerHTML = '<div class="mermaid-diagram">⏳ Mermaid…</div>'; // placeholder first
      return new Promise((res) => {
        setTimeout(() => {
          c.innerHTML = '<div class="mermaid-diagram"><svg></svg></div>'; // resolved
          res();
        }, 5);
      });
    });
    const { printer, printed } = makePrinter({ renderPreview });

    await printer.printPreview({ content: 'x', path: '/p/x.md', name: 'x.md' });

    expect(printed[0]).toContain('<div class="mermaid-diagram"><svg></svg></div>');
    expect(printed[0]).not.toContain('⏳');
  });

  it('aborts with onError and does not print when enhancement times out', async () => {
    const renderPreview = vi.fn(() => new Promise(() => {})); // never resolves
    const { printer, printed, errors } = makePrinter({ renderPreview, timeoutMs: 20 });

    await printer.printPreview({ content: 'x', path: '/p/x.md', name: 'x.md' });

    expect(printed).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/タイムアウト/);
  });

  it('removes the offscreen node even after timeout', async () => {
    const before = document.body.querySelectorAll('div.preview-pane').length;
    const renderPreview = vi.fn(() => new Promise(() => {}));
    const { printer } = makePrinter({ renderPreview, timeoutMs: 20 });
    await printer.printPreview({ content: 'x', path: '/p/x.md', name: 'x.md' });
    const after = document.body.querySelectorAll('div.preview-pane').length;
    expect(after).toBe(before);
  });
});

describe('langForPath', () => {
  it('maps common extensions to highlighter language names', () => {
    expect(langForPath('/a/b.md')).toBe('markdown');
    expect(langForPath('notes.markdown')).toBe('markdown');
    expect(langForPath('x.js')).toBe('javascript');
    expect(langForPath('x.PY')).toBe('python');
    expect(langForPath('x.rs')).toBe('rust');
  });
  it('defaults to markdown when no extension, and empty for .txt', () => {
    expect(langForPath('README')).toBe('markdown');
    expect(langForPath('')).toBe('markdown');
    expect(langForPath('log.txt')).toBe('');
  });
  it('passes unknown extensions through for alias matching', () => {
    expect(langForPath('x.zig')).toBe('zig');
  });
});

describe('createPrinter.printEditor', () => {
  function makeEditorPrinter(highlightCode) {
    const printed = [];
    const printer = createPrinter({
      highlightCode,
      printDocument: (html) => {
        printed.push(html);
        return Promise.resolve();
      },
      cssHref: 'style.css',
    });
    return { printer, printed };
  }

  it('wraps highlighted source in a print-source code block', async () => {
    const highlightCode = vi.fn(async () => '<span class="tok-keyword">const</span> x');
    const { printer, printed } = makeEditorPrinter(highlightCode);
    await printer.printEditor({ content: 'const x', path: '/a/x.js', name: 'x.js' });
    expect(highlightCode).toHaveBeenCalledWith('const x', 'javascript');
    expect(printed[0]).toContain(
      '<pre class="print-source"><code><span class="tok-keyword">const</span> x</code></pre>',
    );
    expect(printed[0]).toContain('<title>x.js</title>');
  });

  it('falls back to escaped plain text when highlight returns null', async () => {
    const highlightCode = vi.fn(async () => null);
    const { printer, printed } = makeEditorPrinter(highlightCode);
    await printer.printEditor({ content: 'a < b & c', path: '/a/x.unknownext', name: 'x' });
    expect(printed[0]).toContain('<pre class="print-source"><code>a &lt; b &amp; c</code></pre>');
  });

  it('escapes plain text even if highlightCode throws', async () => {
    const highlightCode = vi.fn(async () => {
      throw new Error('boom');
    });
    const { printer, printed } = makeEditorPrinter(highlightCode);
    await printer.printEditor({ content: '<x>', path: '/a/x.md', name: 'x.md' });
    expect(printed[0]).toContain('<code>&lt;x&gt;</code>');
  });
});
