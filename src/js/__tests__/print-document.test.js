import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import {
  buildPrintDocument,
  escapeHtml,
  PRINT_CSS,
  printFileName,
} from '../core/print-document.js';

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

describe('印刷文書が 1 ページで切れない', () => {
  // The print document links the app stylesheet, which pins html/body (and
  // .preview-pane) to the window height with overflow hidden for the app
  // layout. Left as is, only the first page's worth of the document prints.
  const appCss = readFileSync(resolve(__dirname, '../../style.css'), 'utf8');

  function computed(bodyClass) {
    const html = buildPrintDocument({ bodyHtml: '<p>x</p>', title: 't', bodyClass });
    const dom = new JSDOM(html.replace('<style>', `<style>${appCss}</style><style>`));
    const win = dom.window;
    const doc = win.document;
    return ['html', 'body', '.print-root'].map((sel) => {
      const s = win.getComputedStyle(doc.querySelector(sel));
      return { sel, height: s.height, overflow: s.overflow, overflowY: s.overflowY };
    });
  }

  for (const bodyClass of ['preview-pane print-root', 'preview-pane print-root print-source']) {
    it(`${bodyClass}: 高さを固定せず、はみ出しを隠さない`, () => {
      for (const s of computed(bodyClass)) {
        expect(s.height, s.sel).not.toBe('100%');
        expect(['hidden', 'auto', 'scroll'], s.sel).not.toContain(s.overflow);
        expect(['hidden', 'auto', 'scroll'], s.sel).not.toContain(s.overflowY);
      }
    });
  }
});

describe('printFileName: PDF 保存の既定のファイル名', () => {
  it('拡張子を除いたファイル名にする', () => {
    expect(printFileName('notes.md')).toBe('notes');
    expect(printFileName('設計メモ.markdown')).toBe('設計メモ');
    expect(printFileName('archive.tar.gz')).toBe('archive.tar');
  });

  it('パスが付いていてもファイル名だけを使う', () => {
    expect(printFileName('/home/u/notes.md')).toBe('notes');
    expect(printFileName('remote://k16/home/u/a.md')).toBe('a');
    expect(printFileName('C:\\Users\\u\\b.md')).toBe('b');
  });

  it('拡張子の無い名前・ドットで始まる名前はそのまま', () => {
    expect(printFileName('README')).toBe('README');
    expect(printFileName('.env')).toBe('.env');
  });

  it('ファイル名に使えない文字は _ にする', () => {
    expect(printFileName('a:b*c?.md')).toBe('a_b_c_');
  });

  it('名前が無ければ Fude', () => {
    expect(printFileName('')).toBe('Fude');
    expect(printFileName(undefined)).toBe('Fude');
    expect(printFileName('   ')).toBe('Fude');
  });
});
