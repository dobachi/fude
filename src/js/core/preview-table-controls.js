// preview-table-controls.js - "+" buttons on a preview table's edges.
//
// A table in the preview is edited cell by cell (double-click), which leaves
// no way to make it bigger. Hovering a top-level table shows two buttons: one
// on its bottom edge adds a row at the end, one on its right edge adds a column
// at the end. (Rows and columns at any other place come from the cell's
// right-click menu or the cell editor's keys; see table-structure.js.)
//
// Like the block "+" (preview-insert.js), the buttons live beside the
// container, never in it: preview-blocks locates the rendered blocks by
// counting the container's children.

export const TABLE_ADD_CLASS = 'preview-table-add';

// Half a button's size (see .preview-table-add): it is centred on the edge.
const BUTTON_HALF_PX = 9;

/**
 * The top-level table the pointer is over, with its source line, or null.
 * Tables nested in a list or quote are edited as part of that block, so they
 * get no buttons.
 */
export function hoveredTable(container, el) {
  const table = el && el.closest ? el.closest('table') : null;
  if (!table || table.parentElement !== container) return null;
  const line = parseInt(table.getAttribute('data-source-line'), 10);
  return Number.isFinite(line) ? { table, line } : null;
}

/** Rows (including the header) and columns of a rendered table. */
export function renderedTableSize(table) {
  const head = table.querySelector('thead > tr');
  return {
    rows: table.querySelectorAll('tbody > tr').length + 1,
    cols: head ? head.children.length : 0,
  };
}

/**
 * Where the two buttons go for a table's box, kept inside the visible part of
 * the preview. Null for a button whose edge is out of sight.
 *
 * @param {{left: number, right: number, top: number, bottom: number}} table
 * @param {{left: number, right: number, top: number, bottom: number}} view
 * @returns {{row: {x: number, y: number} | null, col: {x: number, y: number} | null}}
 */
export function tableButtonPositions(table, view) {
  const clamp = (v, lo, hi) => (hi < lo ? (lo + hi) / 2 : Math.min(Math.max(v, lo), hi));
  const left = Math.max(table.left, view.left);
  const right = Math.min(table.right, view.right);
  const top = Math.max(table.top, view.top);
  const bottom = Math.min(table.bottom, view.bottom);

  const row =
    table.bottom >= view.top && table.bottom <= view.bottom
      ? {
          x: clamp((left + right) / 2, view.left + BUTTON_HALF_PX, view.right - BUTTON_HALF_PX),
          y: clamp(table.bottom, view.top + BUTTON_HALF_PX, view.bottom - BUTTON_HALF_PX),
        }
      : null;
  const col =
    bottom > top
      ? {
          x: clamp(table.right, view.left + BUTTON_HALF_PX, view.right - BUTTON_HALF_PX),
          y: clamp((top + bottom) / 2, view.top + BUTTON_HALF_PX, view.bottom - BUTTON_HALF_PX),
        }
      : null;
  return { row, col };
}

function makeButton(doc, title, kind) {
  const b = doc.createElement('button');
  b.type = 'button';
  b.className = `${TABLE_ADD_CLASS} ${TABLE_ADD_CLASS}--${kind}`;
  b.textContent = '+';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.tabIndex = -1;
  b.hidden = true;
  return b;
}

/**
 * Give a preview container its table edge buttons.
 *
 * @param {HTMLElement} container
 * @param {(req: {container: HTMLElement, line: number, op: string, row: number,
 *   col: number}) => void} onOp
 * @returns {{row: HTMLButtonElement, col: HTMLButtonElement}}
 */
export function attachTableControls(container, onOp) {
  const doc = container.ownerDocument;
  const rowButton = makeButton(doc, '行を追加', 'row');
  const colButton = makeButton(doc, '列を追加', 'col');
  const buttons = [rowButton, colButton];
  let target = null;

  function hide() {
    target = null;
    for (const b of buttons) b.hidden = true;
  }

  function show(hit) {
    if (container.dataset.wholeFile) return hide();
    const pos = tableButtonPositions(
      hit.table.getBoundingClientRect(),
      container.getBoundingClientRect(),
    );
    if (!pos.row && !pos.col) return hide();
    if (!rowButton.isConnected) {
      if (!container.parentElement) return hide();
      container.parentElement.append(rowButton, colButton);
    }
    target = hit;
    for (const [b, p] of [
      [rowButton, pos.row],
      [colButton, pos.col],
    ]) {
      b.hidden = !p;
      if (p) {
        b.style.left = `${p.x}px`;
        b.style.top = `${p.y}px`;
      }
    }
  }

  container.addEventListener('mousemove', (e) => {
    const hit = hoveredTable(container, e.target);
    if (hit) show(hit);
    else hide();
  });
  container.addEventListener('mouseleave', (e) => {
    if (!buttons.includes(e.relatedTarget)) hide();
  });
  for (const b of buttons) {
    b.addEventListener('mouseleave', (e) => {
      const to = e.relatedTarget;
      if (buttons.includes(to)) return;
      if (to && hoveredTable(container, to) && target && to.closest('table') === target.table)
        return;
      hide();
    });
    // Keep the focus where it is; an open cell edit is finished by the
    // handler, in order, rather than by losing focus halfway through.
    b.addEventListener('mousedown', (e) => e.preventDefault());
  }
  container.addEventListener('scroll', hide, { passive: true });

  rowButton.addEventListener('click', () => {
    const t = target;
    hide();
    if (!t || !t.table.isConnected) return;
    const { rows } = renderedTableSize(t.table);
    onOp({ container, line: t.line, op: 'row-below', row: rows - 1, col: 0 });
  });
  colButton.addEventListener('click', () => {
    const t = target;
    hide();
    if (!t || !t.table.isConnected) return;
    const { cols } = renderedTableSize(t.table);
    if (cols < 1) return;
    onOp({ container, line: t.line, op: 'col-right', row: 0, col: cols - 1 });
  });

  return { row: rowButton, col: colButton };
}
