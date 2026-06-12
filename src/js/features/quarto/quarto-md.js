// quarto-md.js — Quarto (.qmd) preview support for markdown-it.
//
// This renders Quarto *notation* without executing code: YAML front matter is
// turned into a title block, `::: {.callout-*}` fenced divs become styled
// callout boxes, and executable cells (```{python} …```) are shown as labelled
// code cells (their output is produced by `quarto render`, which we don't run).
// Everything else falls through to the normal Markdown rendering.

import frontMatterPlugin from 'markdown-it-front-matter';
import containerPlugin from 'markdown-it-container';

const QUARTO_EXT = /\.qmd$/i;

const CALLOUT_KINDS = ['note', 'tip', 'warning', 'caution', 'important'];
const CALLOUT_LABEL = {
  note: 'Note',
  tip: 'Tip',
  warning: 'Warning',
  caution: 'Caution',
  important: 'Important',
};

/** True if the file should be rendered with the Quarto extensions. */
export function isQuartoFile(path) {
  return typeof path === 'string' && QUARTO_EXT.test(path);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Minimal YAML front-matter parse: top-level single-line scalars only
 * (`title:`, `subtitle:`, `author:`, `date:`). Block/nested keys such as
 * `format:` are intentionally ignored — we only need enough for a title block.
 */
export function parseFrontMatter(yaml) {
  const meta = {};
  if (!yaml) return meta;
  const wanted = ['title', 'subtitle', 'author', 'date'];
  for (const raw of String(yaml).split('\n')) {
    // Top level only: a key with no leading indentation.
    const m = raw.match(/^([A-Za-z][\w-]*):[ \t]*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    let val = m[2].trim();
    if (!val) continue; // block key (value on following indented lines) → skip
    val = val.replace(/^["']|["']$/g, ''); // strip surrounding quotes
    if (wanted.includes(key) && !(key in meta)) meta[key] = val;
  }
  return meta;
}

/** HTML for the Quarto title block, or '' when there is no title to show. */
export function renderFrontMatterHeader(meta) {
  if (!meta || !meta.title) return '';
  let html = '<header class="quarto-title-block">';
  html += `<h1 class="quarto-title">${escapeHtml(meta.title)}</h1>`;
  if (meta.subtitle) html += `<p class="quarto-subtitle">${escapeHtml(meta.subtitle)}</p>`;
  const byline = [];
  if (meta.author) byline.push(escapeHtml(meta.author));
  if (meta.date) byline.push(escapeHtml(meta.date));
  if (byline.length) html += `<p class="quarto-meta">${byline.join(' · ')}</p>`;
  html += '</header>\n';
  return html;
}

/**
 * If a fence info string denotes a Quarto executable cell (`{python}`,
 * `{r}`, `{python echo=false}`, …) return `{ lang }`, else null. A leading dot
 * (`{.python}`) is Pandoc's attributed *display* block, not an executable cell,
 * so it is deliberately excluded.
 */
export function parseCellInfo(info) {
  if (!info) return null;
  const m = String(info)
    .trim()
    .match(/^\{=?([A-Za-z][\w-]*)[\s\S]*\}$/);
  return m ? { lang: m[1] } : null;
}

function calloutKind(params) {
  const m = String(params).match(/callout-(note|tip|warning|caution|important)\b/);
  return m ? m[1] : null;
}

function calloutTitle(params) {
  const m = String(params).match(/title\s*=\s*"([^"]*)"/);
  return m ? m[1] : null;
}

function renderExecCell(token, lang, line) {
  return (
    `<pre class="quarto-cell" data-exec-lang="${escapeHtml(lang)}"` +
    (line ? ` data-source-line="${line}"` : '') +
    `><span class="quarto-cell-label">${escapeHtml(lang)}</span>` +
    `<code class="language-${escapeHtml(lang)}">${escapeHtml(token.content)}</code></pre>\n`
  );
}

/**
 * Apply the Quarto extensions to a markdown-it instance:
 *  - front matter: stripped from the body, reported via opts.onFrontMatter(raw)
 *  - `::: {.callout-*}` fenced divs → styled callout boxes
 *  - executable cells → labelled code cells (no execution)
 * The instance is expected to already carry the app's base rules (the exec-cell
 * fence renderer wraps the existing fence renderer rather than replacing it).
 */
export function applyQuartoExtensions(md, { onFrontMatter } = {}) {
  md.use(frontMatterPlugin, (fm) => {
    if (onFrontMatter) onFrontMatter(fm);
  });

  md.use(containerPlugin, 'callout', {
    validate: (params) => calloutKind(params) !== null,
    render: (tokens, idx) => {
      const token = tokens[idx];
      if (token.nesting === 1) {
        const kind = calloutKind(token.info) || 'note';
        const title = calloutTitle(token.info) || CALLOUT_LABEL[kind];
        const line = token.map ? ` data-source-line="${token.map[0] + 1}"` : '';
        return (
          `<div class="callout callout-${kind}"${line}>` +
          `<div class="callout-header">${escapeHtml(title)}</div>` +
          `<div class="callout-body">\n`
        );
      }
      return '</div></div>\n';
    },
  });

  const baseFence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const cell = parseCellInfo(tokens[idx].info);
    if (cell) {
      const line = tokens[idx].attrGet('data-source-line') || '';
      return renderExecCell(tokens[idx], cell.lang, line);
    }
    return baseFence(tokens, idx, options, env, self);
  };
}

export { CALLOUT_KINDS };
