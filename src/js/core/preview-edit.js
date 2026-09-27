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

/**
 * The table cell under `el`, when `el` is inside a table that is itself a
 * top-level block (`blockEl`). Nested tables (in a list or quote) are edited
 * as part of their enclosing block instead.
 *
 * @returns {{cellEl: HTMLElement, row: number, col: number} | null}
 *   row 0 is the header row; body rows count from 1.
 */
export function tableCellOf(blockEl, el) {
  if (!blockEl || blockEl.tagName !== 'TABLE' || !el || !el.closest) return null;
  const cellEl = el.closest('th, td');
  if (!cellEl || cellEl.closest('table') !== blockEl) return null;
  const tr = cellEl.parentElement;
  const section = tr && tr.parentElement;
  if (!section) return null;
  const col = Array.prototype.indexOf.call(tr.children, cellEl);
  let row;
  if (section.tagName === 'THEAD') row = 0;
  else if (section.tagName === 'TBODY')
    row = Array.prototype.indexOf.call(section.children, tr) + 1;
  else return null;
  return { cellEl, row, col };
}

/**
 * The top-level table block that starts on source `line` in a preview
 * container, or null.
 */
export function previewTableAt(container, line) {
  for (const el of container.children) {
    if (el.tagName === 'TABLE' && el.getAttribute('data-source-line') === String(line)) return el;
  }
  return null;
}

/** Cell (row, col) of a rendered table, row 0 being the header row; or null. */
export function tableCellElement(table, row, col) {
  if (!table || row < 0 || col < 0) return null;
  const tr =
    row === 0 ? table.querySelector('thead > tr') : table.querySelectorAll('tbody > tr')[row - 1];
  return (tr && tr.children[col]) || null;
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
 * @param {HTMLElement} [opts.cellEl] edit inside this element instead of
 *   swapping `blockEl` (a table cell: its content is set aside while the
 *   editor sits in it, so the table keeps its layout)
 * @param {string} opts.text the block's source
 * @param {number} [opts.cursor] initial caret offset
 * @param {(host: HTMLElement, text: string, handlers: {commit: () => void},
 *   cursor: number) => {state: {doc: {toString(): string}}, destroy(): void, focus?(): void}} opts.mountEditor
 * @param {(edited: string) => void} opts.onCommit
 * @param {(edited: string) => void} [opts.onCancel]
 * @param {(dir: 1|-1) => void} [opts.onMove] called after onCommit when the
 *   editor asked to move to the next (1) or previous (-1) cell
 */
export function startInlineEdit(opts) {
  commitInlineEdit();
  const { container, blockEl, cellEl } = opts;
  const doc = blockEl.ownerDocument;

  const host = doc.createElement('div');
  host.className = INLINE_EDITOR_CLASS;
  let saved = null;
  if (cellEl) {
    host.classList.add(`${INLINE_EDITOR_CLASS}--cell`);
    saved = doc.createDocumentFragment();
    while (cellEl.firstChild) saved.appendChild(cellEl.firstChild);
    cellEl.appendChild(host);
  } else {
    // Keep scroll sync working while the editor stands in for the block.
    const line = blockEl.getAttribute('data-source-line');
    if (line) host.setAttribute('data-source-line', line);
    blockEl.replaceWith(host);
  }

  const edit = { container, blockEl, cellEl, saved, host, opts, view: null };
  active = edit;

  edit.view = opts.mountEditor(
    host,
    opts.text,
    {
      commit: () => finish(edit, 'commit', true),
      move: (dir) => finish(edit, 'commit', true, dir),
    },
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

function finish(edit, kind, refocus, moveDir = 0) {
  if (active !== edit) return;
  active = null;
  const edited = edit.view ? edit.view.state.doc.toString() : edit.opts.text;
  if (edit.view) edit.view.destroy();
  if (edit.cellEl) {
    edit.host.remove();
    edit.cellEl.appendChild(edit.saved);
  } else if (edit.host.isConnected) {
    edit.host.replaceWith(edit.blockEl);
  }
  if (refocus && edit.container && edit.container.isConnected) {
    edit.container.focus({ preventScroll: true });
  }
  if (kind === 'commit') edit.opts.onCommit(edited);
  else if (edit.opts.onCancel) edit.opts.onCancel(edited);
  // Moving (Tab in a table cell) is "commit, then open the neighbour"; the
  // caller opens it once the commit has been rendered.
  if (moveDir && edit.opts.onMove) edit.opts.onMove(moveDir);
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
