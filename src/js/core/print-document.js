// print-document.js - Pure builder for the HTML document that gets printed.
//
// Fude prints by writing a self-contained document into a hidden <iframe> and
// calling its contentWindow.print() (see features/print/print.js). Keeping the
// string assembly here — with no DOM or Tauri access — makes it unit-testable.
//
// The printed document always uses the light theme (paper/PDF should not carry
// a dark background) and pulls in the app stylesheet so `.preview-pane`
// typography, `tok-*` syntax colors, and diagram SVG styling match the screen.

/** Print-specific CSS layered on top of the app stylesheet. */
export const PRINT_CSS = `
@page { margin: 16mm; }
html, body { background: #fff; margin: 0; }
.print-root { max-width: 100%; padding: 0; }
/* Emit background colors / diagram fills on paper too. */
* { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
/* Avoid slicing atomic blocks across page boundaries. */
pre, .mermaid-diagram, .puml-diagram, img, table, blockquote { break-inside: avoid; }
h1, h2, h3, h4 { break-after: avoid; }
.mermaid-diagram svg, .puml-diagram svg, img { max-width: 100%; height: auto; }
/* Source view (editor print): monospace, wrapped, preserved whitespace. */
.print-source { white-space: pre-wrap; word-break: break-word; font-family: var(--font-mono, monospace); }
`;

/**
 * Escape a string for safe insertion into HTML text / attribute contexts.
 * @param {string} s
 * @returns {string}
 */
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Build the full HTML document string for the print iframe.
 *
 * @param {object} o
 * @param {string} o.bodyHtml   Trusted, already-rendered inner HTML (preview
 *                              output or highlighted source). Inserted verbatim.
 * @param {string} o.title      Document title (escaped).
 * @param {string} [o.cssHref]  Href of the app stylesheet to link (e.g. 'style.css').
 * @param {string} [o.extraCss] Extra CSS; defaults to PRINT_CSS.
 * @param {string} [o.bodyClass] Root element class; defaults to the preview class.
 * @returns {string}
 */
export function buildPrintDocument({
  bodyHtml,
  title,
  cssHref,
  extraCss = PRINT_CSS,
  bodyClass = 'preview-pane print-root',
}) {
  const link = cssHref ? `<link rel="stylesheet" href="${escapeHtml(cssHref)}" />` : '';
  return `<!doctype html>
<html data-theme="light">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title || '')}</title>
${link}
<style>${extraCss}</style>
</head>
<body>
<div class="${escapeHtml(bodyClass)}">${bodyHtml ?? ''}</div>
</body>
</html>`;
}
