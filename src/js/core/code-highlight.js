// code-highlight.js - Syntax highlighting for preview code blocks.
//
// Reuses the CodeMirror language parsers that are already bundled for the
// editor (`@codemirror/language-data`) so the preview shows the exact same
// languages with no extra highlighting engine. Tokens are emitted with the
// stable `tok-*` class names from `@lezer/highlight`'s classHighlighter; the
// actual colors live in CSS (style.css), so they follow the active theme.
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { highlightTree, classHighlighter } from '@lezer/highlight';

// Cache loaded LanguageSupport per resolved language name. The value is a
// Promise so concurrent code blocks of the same language share one load.
const supportCache = new Map();

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escape text for safe insertion as HTML content.
 * @param {string} s
 * @returns {string}
 */
export function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/**
 * Resolve a fence info string (e.g. "js", "python", "c++") to a CodeMirror
 * LanguageDescription, or null when no bundled language matches.
 * @param {string} langName
 * @returns {import('@codemirror/language').LanguageDescription|null}
 */
export function resolveLanguage(langName) {
  if (!langName) return null;
  return LanguageDescription.matchLanguageName(languages, langName, true);
}

/**
 * Lazily load (and cache) the LanguageSupport for a fence language.
 * @param {string} langName
 * @returns {Promise<import('@codemirror/language').LanguageSupport|null>}
 */
export async function loadSupport(langName) {
  const desc = resolveLanguage(langName);
  if (!desc) return null;
  if (!supportCache.has(desc.name)) {
    supportCache.set(
      desc.name,
      Promise.resolve(desc.load()).catch(() => null),
    );
  }
  return supportCache.get(desc.name);
}

/**
 * Highlight `code` to an HTML string using an already-loaded LanguageSupport.
 * Styled ranges become `<span class="tok-...">`; gaps are escaped text. The
 * output is always HTML-safe.
 * @param {string} code
 * @param {import('@codemirror/language').LanguageSupport} support
 * @returns {string}
 */
export function highlightToHtmlSync(code, support) {
  const tree = support.language.parser.parse(code);
  let out = '';
  let pos = 0;
  highlightTree(tree, classHighlighter, (from, to, classes) => {
    if (from > pos) out += escapeHtml(code.slice(pos, from));
    out += `<span class="${classes}">${escapeHtml(code.slice(from, to))}</span>`;
    pos = to;
  });
  if (pos < code.length) out += escapeHtml(code.slice(pos));
  return out;
}

/**
 * Highlight `code` for the given fence language. Returns an HTML string of
 * `tok-*` spans, or null when the language is unknown or parsing fails (the
 * caller should then leave the original plain-text block untouched).
 * @param {string} code
 * @param {string} langName
 * @returns {Promise<string|null>}
 */
export async function highlightCode(code, langName) {
  const support = await loadSupport(langName);
  if (!support) return null;
  try {
    return highlightToHtmlSync(code, support);
  } catch {
    return null;
  }
}

// Exposed for tests.
export function _clearCacheForTest() {
  supportCache.clear();
}
