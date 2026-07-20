// features/print/print.js - Print orchestration (v1: rendered preview).
//
// Strategy (see docs/PRINT.md): render the document into an offscreen
// container, await full enhancement (diagrams → SVG, syntax highlight), then
// write a self-contained document into a hidden <iframe> and call its
// contentWindow.print(). The OS print dialog covers both physical printing and
// "Print to File" (PDF). Loaded lazily from app.js to keep it off the hot path.

import { buildPrintDocument } from '../../core/print-document.js';

const DEFAULT_TIMEOUT_MS = 10000;
const AFTERPRINT_FALLBACK_MS = 60000;

/**
 * @param {object} deps
 * @param {Document} [deps.doc]
 * @param {(content:string, basePath:string, container:HTMLElement, filePath?:string)=>(Promise<void>|void)} deps.renderPreview
 * @param {(path:string)=>string} deps.dirname   derive a base directory from a file path
 * @param {(message:string)=>void} [deps.onError]
 * @param {string} [deps.cssHref]                app stylesheet to link (default 'style.css')
 * @param {(html:string)=>Promise<void>} [deps.printDocument] injectable print sink (default: hidden iframe)
 * @param {number} [deps.timeoutMs]
 */
export function createPrinter(deps) {
  const {
    doc = typeof document !== 'undefined' ? document : null,
    renderPreview,
    dirname = defaultDirname,
    onError,
    cssHref = 'style.css',
    printDocument,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = deps;

  const sink = printDocument || ((html) => printViaIframe(doc, html));

  /** Render `tab` into an offscreen node and return its finished innerHTML,
   *  or null if enhancement did not complete within the timeout. */
  async function snapshotPreviewHtml(tab) {
    const off = doc.createElement('div');
    off.className = 'preview-pane';
    off.style.cssText = 'position:absolute;left:-99999px;top:0;width:820px;visibility:hidden';
    doc.body.appendChild(off);
    try {
      const basePath = tab.path ? dirname(tab.path) : '';
      const rendered = Promise.resolve(renderPreview(tab.content || '', basePath, off, tab.path));
      const completed = await settledWithin(rendered, timeoutMs);
      if (!completed) return null;
      return off.innerHTML;
    } finally {
      off.remove();
    }
  }

  async function printPreview(tab) {
    if (!doc || !tab) return;
    const body = await snapshotPreviewHtml(tab);
    if (body == null) {
      onError?.('図の描画待ちでタイムアウトしました。印刷を中止しました。');
      return;
    }
    const html = buildPrintDocument({ bodyHtml: body, title: tab.name || 'Fude', cssHref });
    await sink(html);
  }

  return { printPreview, snapshotPreviewHtml };
}

function defaultDirname(path) {
  if (!path) return '';
  const norm = String(path).replace(/\\/g, '/');
  const i = norm.lastIndexOf('/');
  return i >= 0 ? norm.slice(0, i) : '';
}

/**
 * Resolve to `true` if `promise` settles before `ms`, `false` on timeout.
 * A rejection still counts as "settled" — a failed render should not block the
 * snapshot (the error surfaces as an inline diagram-error in the HTML).
 */
function settledWithin(promise, ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => finish(false), ms);
    promise.then(
      () => finish(true),
      () => finish(true),
    );
  });
}

/** Print `html` by loading it into a throwaway hidden iframe. */
function printViaIframe(doc, html) {
  return new Promise((resolve) => {
    const iframe = doc.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    // The iframe must have a real layout size: a 0x0 iframe lays out its
    // document at zero width and prints BLANK on WebKitGTK. Park it offscreen
    // at A4 size instead of collapsing it.
    iframe.style.cssText =
      'position:fixed;left:-10000px;top:0;width:210mm;height:297mm;border:0;background:#fff';
    let done = false;
    let printed = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      iframe.remove();
      resolve();
    };
    // Guard against the iframe firing `load` more than once (WebKitGTK emits an
    // initial about:blank load in addition to the srcdoc load) — otherwise the
    // print dialog would open twice.
    iframe.addEventListener('load', () => {
      if (printed) return;
      printed = true;
      const win = iframe.contentWindow;
      if (!win) return cleanup();
      // afterprint is the primary teardown signal; a timer backs it up because
      // some platforms (notably WebKitGTK) may not fire it reliably.
      if (typeof win.addEventListener === 'function') win.addEventListener('afterprint', cleanup);
      // Let the engine apply the linked stylesheet and lay out inline SVG
      // before printing; printing too eagerly can yield blank output.
      setTimeout(() => {
        try {
          win.focus();
          win.print();
        } catch {
          cleanup();
          return;
        }
        setTimeout(cleanup, AFTERPRINT_FALLBACK_MS);
      }, 120);
    });
    // Set srcdoc before appending so the content load is the first (and ideally
    // only) load event, then append to start loading.
    iframe.srcdoc = html;
    doc.body.appendChild(iframe);
  });
}
