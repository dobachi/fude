import { describe, it, expect, vi } from 'vitest';
import { createPrinter } from '../features/print/print.js';

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
