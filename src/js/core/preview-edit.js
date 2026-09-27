// preview-edit.js - edit a rendered block's Markdown source in place, inside
// the preview.
//
// The source stays the single source of truth. Double-clicking a block swaps
// its rendered element for a small editor holding that block's source lines;
// finishing the edit swaps the element back and hands the edited text to the
// caller, which writes it into the real editor as one change. The preview then
// re-renders from the source like after any other edit.
//
// The swap is one element for one element, the same shape as the diagram
// passes' `pre.replaceWith(holder)`, so preview-blocks' node-count bookkeeping
// stays valid while an edit is open.

import { splitTopLevelBlocks } from './preview-blocks.js';

export const INLINE_EDITOR_CLASS = 'preview-inline-editor';

/**
 * Source line range of the top-level block that starts on `line`.
 *
 * @param {object} md markdown-it instance the preview renders with
 * @param {string} text whole document
 * @param {number} line 1-based start line, as carried by `data-source-line`
 * @returns {{from: number, to: number} | null} 1-based inclusive line range
 */
export function blockLineRange(md, text, line) {
  const tokens = md.parse(text, {});
  for (const block of splitTopLevelBlocks(tokens)) {
    const map = block[0].map;
    if (!map) continue;
    if (map[0] + 1 === line) {
      // map[1] is the exclusive 0-based end, i.e. the inclusive 1-based end.
      // Lists (and some other containers) count the blank line after them;
      // leave it out, or deleting it in the editor would glue the next block
      // on. A block never ends before it starts; guard against odd maps.
      const lines = text.split('\n');
      let to = Math.max(line, map[1]);
      while (to > line && !(lines[to - 1] || '').trim()) to -= 1;
      return { from: line, to };
    }
  }
  return null;
}

/**
 * Where to put the caret when the editor opens: at the word the user
 * double-clicked, if it can be found in the block's source, else at the start.
 * The rendered text and the source differ (markup, escapes), so this is a best
 * effort, not a mapping.
 *
 * @param {string} source block source
 * @param {string} word text the double-click selected in the preview
 * @returns {number} offset into `source`
 */
export function guessCursor(source, word) {
  const w = (word || '').trim();
  if (!w) return 0;
  const i = source.indexOf(w);
  return i < 0 ? 0 : i;
}

/**
 * The top-level block element of a preview container that contains `el`.
 * @returns {Element|null}
 */
export function topLevelBlockOf(container, el) {
  let node = el && el.nodeType === 1 ? el : el && el.parentElement;
  while (node && node.parentElement !== container) node = node.parentElement;
  return node && node.parentElement === container ? node : null;
}

/** True if `el` sits inside an open inline editor. */
export function isInsideInlineEditor(el) {
  return !!(el && el.closest && el.closest(`.${INLINE_EDITOR_CLASS}`));
}

// At most one edit is open at a time, across all panes.
let active = null;

/**
 * Open an inline editor in place of `blockEl`.
 *
 * Any edit already open is committed first.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.container preview container (focus returns here)
 * @param {HTMLElement} opts.blockEl the rendered block to swap out
 * @param {string} opts.text the block's source
 * @param {number} [opts.cursor] initial caret offset
 * @param {(host: HTMLElement, text: string, handlers: {commit: () => void},
 *   cursor: number) => {state: {doc: {toString(): string}}, destroy(): void, focus?(): void}} opts.mountEditor
 * @param {(edited: string) => void} opts.onCommit
 * @param {(edited: string) => void} [opts.onCancel]
 */
export function startInlineEdit(opts) {
  commitInlineEdit();
  const { container, blockEl } = opts;
  const doc = blockEl.ownerDocument;

  const host = doc.createElement('div');
  host.className = INLINE_EDITOR_CLASS;
  // Keep scroll sync working while the editor stands in for the block.
  const line = blockEl.getAttribute('data-source-line');
  if (line) host.setAttribute('data-source-line', line);
  blockEl.replaceWith(host);

  const edit = { container, blockEl, host, opts, view: null };
  active = edit;

  edit.view = opts.mountEditor(
    host,
    opts.text,
    { commit: () => finish(edit, 'commit', true) },
    opts.cursor || 0,
  );

  // Leaving the editor finishes the edit. A focusout with no new target while
  // the window itself lost focus (switching apps) is not "leaving": the user
  // comes back to the same caret.
  host.addEventListener('focusout', (e) => {
    const next = e.relatedTarget;
    if (next && host.contains(next)) return;
    if (!next && typeof doc.hasFocus === 'function' && !doc.hasFocus()) return;
    finish(edit, 'commit', false);
  });

  if (edit.view && typeof edit.view.focus === 'function') edit.view.focus();
  return edit;
}

function finish(edit, kind, refocus) {
  if (active !== edit) return;
  active = null;
  const edited = edit.view ? edit.view.state.doc.toString() : edit.opts.text;
  if (edit.view) edit.view.destroy();
  if (edit.host.isConnected) edit.host.replaceWith(edit.blockEl);
  if (refocus && edit.container && edit.container.isConnected) {
    edit.container.focus({ preventScroll: true });
  }
  if (kind === 'commit') edit.opts.onCommit(edited);
  else if (edit.opts.onCancel) edit.opts.onCancel(edited);
}

/** Finish the open edit (if any), applying it. */
export function commitInlineEdit() {
  if (active) finish(active, 'commit', false);
}

/** Close the open edit (if any) without applying it; onCancel gets the text. */
export function cancelInlineEdit() {
  if (active) finish(active, 'cancel', false);
}

/** True while an inline edit is open (optionally: in this container). */
export function isInlineEditing(container) {
  return !!active && (!container || active.container === container);
}
