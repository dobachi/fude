import { describe, it, expect } from 'vitest';
import { buildPrintDocument, escapeHtml, PRINT_CSS } from '../core/print-document.js';

describe('escapeHtml', () => {
  it('escapes HTML metacharacters', () => {
    expect(escapeHtml('<b>"a & b"</b>')).toBe('&lt;b&gt;&quot;a &amp; b&quot;&lt;/b&gt;');
  });
  it('handles nullish', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});

describe('buildPrintDocument', () => {
  it('produces a light-themed doctype document', () => {
    const html = buildPrintDocument({ bodyHtml: '<p>hi</p>', title: 'Doc' });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html data-theme="light">');
    expect(html).toContain('<title>Doc</title>');
  });

  it('inserts bodyHtml verbatim inside the preview root', () => {
    const html = buildPrintDocument({ bodyHtml: '<h1>Title</h1><svg></svg>', title: 't' });
    expect(html).toContain('<div class="preview-pane print-root"><h1>Title</h1><svg></svg></div>');
  });

  it('links the stylesheet when cssHref is given, omits it otherwise', () => {
    expect(buildPrintDocument({ bodyHtml: '', title: 't', cssHref: 'style.css' })).toContain(
      '<link rel="stylesheet" href="style.css" />',
    );
    expect(buildPrintDocument({ bodyHtml: '', title: 't' })).not.toContain('<link');
  });

  it('applies PRINT_CSS by default and includes print-color-adjust', () => {
    const html = buildPrintDocument({ bodyHtml: '', title: 't' });
    expect(html).toContain(PRINT_CSS);
    expect(html).toContain('print-color-adjust: exact');
  });

  it('escapes the title but not the trusted body', () => {
    const html = buildPrintDocument({ bodyHtml: '<em>ok</em>', title: '<script>x</script>' });
    expect(html).toContain('<title>&lt;script&gt;x&lt;/script&gt;</title>');
    expect(html).toContain('<em>ok</em>'); // body inserted as-is
  });

  it('allows overriding the body class (editor print uses print-source)', () => {
    const html = buildPrintDocument({
      bodyHtml: 'code',
      title: 't',
      bodyClass: 'preview-pane print-root print-source',
    });
    expect(html).toContain('<div class="preview-pane print-root print-source">code</div>');
  });
});
