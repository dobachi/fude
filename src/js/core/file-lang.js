// file-lang.js - Map a file path to an editor language.
//
// Fude is a Markdown editor: by default every text file is edited and previewed
// as Markdown. The optional "source code mode" lets non-Markdown files open with
// their own CodeMirror language (and as editor-only, since a Markdown preview of
// source code is meaningless). The decisions here are pure so they can be unit
// tested without CodeMirror or the DOM.
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';

// Extensions that should always be treated as Markdown (full editor + preview),
// even when source code mode is on. Quarto/R-Markdown are Markdown supersets.
const MARKDOWN_EXTS = new Set([
  'md',
  'markdown',
  'mdown',
  'mkd',
  'mkdn',
  'mdwn',
  'mdx',
  'mdtext',
  'qmd',
  'rmd',
]);

/**
 * Lowercased file extension without the dot, or '' when there is none.
 * @param {string} path
 * @returns {string}
 */
export function extOf(path) {
  if (!path) return '';
  const base = String(path).split(/[\\/]/).pop();
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return ''; // no dot, or dotfile like ".gitignore"
  return base.slice(dot + 1).toLowerCase();
}

/**
 * True when the file should be handled as Markdown (the editor default).
 * @param {string} path
 * @returns {boolean}
 */
export function isMarkdownPath(path) {
  return MARKDOWN_EXTS.has(extOf(path));
}

/**
 * Resolve a path to a CodeMirror LanguageDescription by filename, or null when
 * no bundled language matches (Markdown files and unknown extensions).
 * @param {string} path
 * @returns {import('@codemirror/language').LanguageDescription|null}
 */
export function languageDescForPath(path) {
  if (!path || isMarkdownPath(path)) return null;
  const base = String(path).split(/[\\/]/).pop();
  return LanguageDescription.matchFilename(languages, base);
}

/**
 * Whether opening `path` in source code mode should use a non-Markdown editor
 * (language highlighting + editor-only view). True for any non-Markdown file
 * when the mode is enabled — even ones without a known language, which open as
 * plain text rather than being mis-rendered as Markdown.
 * @param {string} path
 * @param {boolean} sourceCodeMode
 * @returns {boolean}
 */
export function shouldOpenAsCode(path, sourceCodeMode) {
  return !!sourceCodeMode && !!path && !isMarkdownPath(path);
}
