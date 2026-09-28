// preview-insert.js - add a new block between two rendered blocks, from the
// preview.
//
// Double-clicking edits a block that exists (preview-edit.js). That leaves no
// way to write *after* a block whose editing unit is smaller than the block —
// a table is edited cell by cell — or into an empty document. So: hovering the
// preview's left margin shows a "+" at the nearest boundary between blocks;
// clicking it opens an empty inline editor there, and what is typed goes into
// the source as a block of its own.

export const INSERT_BUTTON_CLASS = 'preview-insert-button';

// Fallback for the margin's width when the stylesheet's padding can't be read.
const DEFAULT_GUTTER_PX = 32;

// Half the button's height (see .preview-insert-button). The button is centred
// on its boundary, so this much of it would stick out past the preview's edge —
// over the neighbouring pane or the handle between panes — for a boundary that
// sits right at that edge.
const BUTTON_HALF_PX = 10;

/** Where to centre the button for a boundary at `at`, kept inside top..bottom. */
export function clampButtonY(at, top, bottom) {
  const lo = top + BUTTON_HALF_PX;
  const hi = bottom - BUTTON_HALF_PX;
  if (hi < lo) return (top + bottom) / 2;
  return Math.min(Math.max(at, lo), hi);
}

/**
 * The change that adds `newText` to `text` as a block of its own after line
 * `afterLine`.
 *
 * The new block is set off by a blank line on both sides. Without the one
 * before it, text after a table becomes a table row and text after a paragraph
 * joins the paragraph; without the one after it, the following block can be
 * swallowed the same way.
 *
 * @param {string} text whole document, lines separated by "\n"
 * @param {number} afterLine 1-based line to insert after; 0 for the top.
 *   Blank lines just above the insertion point are skipped, so the block lands
 *   right under the content before it rather than adding to the gap.
 * @param {string} newText
 * @returns {{from: number, insert: string} | null} null when there is nothing
 *   to insert
 */
export function insertBlockChange(text, afterLine, newText) {
  const body = String(newText ?? '')
    .replace(/^(?:[ \t]*\n)+/, '')
    .replace(/\s+$/, '');
  if (!body) return null;

  const lines = String(text ?? '').split('\n');
  let after = Math.min(Math.max(0, Math.floor(afterLine) || 0), lines.length);
  while (after > 0 && !lines[after - 1].trim()) after -= 1;

  if (after === 0) {
    return { from: 0, insert: `${body}\n${lines[0].trim() ? '\n' : ''}` };
  }

  let from = after - 1; // the newlines before line `after`
  for (let i = 0; i < after; i++) from += lines[i].length;
  const next = lines[after];
  return { from, insert: `\n\n${body}${next !== undefined && next.trim() ? '\n' : ''}` };
}

/**
 * The boundary between blocks nearest to a vertical position.
 *
 * Blocks are read through `rectAt` and searched by bisection, so a long
 * document costs a handful of layout reads per pointer move, not one per
 * block.
 *
 * @param {number} count number of blocks, in document order
 * @param {(i: number) => {top: number, bottom: number}} rectAt
 * @param {number} y
 * @returns {{index: number, y: number} | null} `index` blocks lie above the
 *   boundary (0 = before the first block, `count` = after the last); `y` is
 *   where the boundary sits. Null when there are no blocks.
 */
export function nearestGap(count, rectAt, y) {
  if (!(count > 0)) return null;
  // First block that does not end above the pointer.
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rectAt(mid).bottom < y) lo = mid + 1;
    else hi = mid;
  }
  const r = rectAt(lo);
  const index = y > (r.top + r.bottom) / 2 ? lo + 1 : lo;

  let at;
  if (index <= 0) at = rectAt(0).top;
  else if (index >= count) at = rectAt(count - 1).bottom;
  else at = (rectAt(index - 1).bottom + rectAt(index).top) / 2;
  return { index, y: at };
}

/** Source line a top-level block carries itself, or null. */
function ownSourceLine(container, el) {
  if (!el || el.parentElement !== container) return null;
  const line = parseInt(el.getAttribute('data-source-line'), 10);
  return Number.isFinite(line) ? line : null;
}

/**
 * Tie a boundary between two top-level blocks to the source.
 *
 * Preferably "after the block above"; if that block can't be placed — it
 * carries no source line (raw HTML, a Quarto title block), or it has been
 * re-rendered since the boundary was picked — "before the block below" is the
 * same spot. With nothing below, the boundary is the end of the document.
 *
 * @param {HTMLElement} container
 * @param {Element|null} prevEl block above the boundary
 * @param {Element|null} nextEl block below the boundary
 * @returns {{el: Element|null, where: 'before'|'after', line: number|null} | null}
 *   `el` is the block the editor opens next to; `line` its source line, null
 *   meaning the end of the document. Null when the boundary can't be placed.
 */
export function resolveGap(container, prevEl, nextEl) {
  const prev = ownSourceLine(container, prevEl);
  if (prev !== null) return { el: prevEl, where: 'after', line: prev };
  const next = ownSourceLine(container, nextEl);
  if (next !== null) return { el: nextEl, where: 'before', line: next };
  if (!nextEl || !nextEl.isConnected) {
    return { el: container.lastElementChild, where: 'after', line: null };
  }
  return null;
}

/**
 * The source line a resolved boundary inserts after.
 *
 * @param {{where: 'before'|'after', line: number|null}} gap from resolveGap
 * @param {number} lineCount lines in the document
 * @param {(line: number) => {from: number, to: number} | null} blockRange
 *   source range of the block starting on a line
 * @returns {number|null} 1-based line, 0 for the top; null when the block the
 *   boundary hangs on can't be found in the source
 */
export function gapAfterLine(gap, lineCount, blockRange) {
  if (gap.line === null) return lineCount;
  if (gap.where === 'before') return gap.line - 1;
  const range = blockRange(gap.line);
  return range ? range.to : null;
}

function paddingPx(container, side) {
  const view = container.ownerDocument.defaultView;
  const px = view ? parseFloat(view.getComputedStyle(container)[side]) : NaN;
  return px > 0 ? px : 0;
}

/**
 * Give a preview container its "+" button.
 *
 * The button lives beside the container, never in it: the container's children
 * are the rendered blocks, which preview-blocks locates by counting nodes. One
 * button per container, so every pane of a split has its own.
 *
 * @param {HTMLElement} container
 * @param {(req: {container: HTMLElement, prevEl: Element|null,
 *   nextEl: Element|null}) => void} onInsert
 * @returns {HTMLButtonElement}
 */
export function attachInsertButton(container, onInsert) {
  const doc = container.ownerDocument;
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = INSERT_BUTTON_CLASS;
  button.textContent = '+';
  button.title = 'ここに行を追加';
  button.setAttribute('aria-label', 'ここに行を追加');
  button.tabIndex = -1;
  button.hidden = true;

  let target = null;

  function hide() {
    target = null;
    button.hidden = true;
  }

  function update(x, y) {
    // A whole-file diagram has no blocks to write between.
    if (container.dataset.wholeFile) return hide();
    const box = container.getBoundingClientRect();
    const gutter = paddingPx(container, 'paddingLeft') || DEFAULT_GUTTER_PX;
    if (x < box.left || x > box.left + gutter) return hide();

    const blocks = container.children;
    const gap = nearestGap(blocks.length, (i) => blocks[i].getBoundingClientRect(), y);
    const prevEl = gap ? blocks[gap.index - 1] || null : null;
    const nextEl = gap ? blocks[gap.index] || null : null;
    if (!resolveGap(container, prevEl, nextEl)) return hide();

    // An empty document: offer its first line, where the text would start.
    const at = gap ? gap.y : box.top + paddingPx(container, 'paddingTop');
    // A boundary scrolled out of sight is not one to point at.
    if (at < box.top || at > box.bottom) return hide();

    // Attached on first use, next to the container, so it goes away with the
    // pane it belongs to.
    if (!button.isConnected) {
      if (!container.parentElement) return hide();
      container.parentElement.appendChild(button);
    }
    target = { prevEl, nextEl };
    button.style.left = `${box.left + gutter / 2}px`;
    button.style.top = `${clampButtonY(at, box.top, box.bottom)}px`;
    button.hidden = false;
  }

  container.addEventListener('mousemove', (e) => update(e.clientX, e.clientY));
  container.addEventListener('mouseleave', (e) => {
    if (e.relatedTarget !== button) hide();
  });
  button.addEventListener('mouseleave', (e) => {
    if (!container.contains(e.relatedTarget)) hide();
  });
  // The blocks move under a button that stays put.
  container.addEventListener('scroll', hide, { passive: true });

  // Keep the focus where it is: an inline edit still open is finished by the
  // click handler, in order, rather than by losing focus halfway through.
  button.addEventListener('mousedown', (e) => e.preventDefault());
  button.addEventListener('click', () => {
    const picked = target;
    hide();
    if (picked) onInsert({ container, prevEl: picked.prevEl, nextEl: picked.nextEl });
  });

  return button;
}
