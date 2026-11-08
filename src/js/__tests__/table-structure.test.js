import { describe, it, expect, afterEach, vi } from 'vitest';
import { applyTableOp, tableOpsAvailable, TABLE_OPS } from '../core/table-structure.js';
import { formatTableText, parseTableBlock } from '../core/table.js';
import {
  attachTableControls,
  hoveredTable,
  renderedTableSize,
  tableButtonPositions,
  TABLE_ADD_CLASS,
} from '../core/preview-table-controls.js';
import { startInlineEdit, cancelInlineEdit } from '../core/preview-edit.js';
import { renderMarkdown } from '../core/preview.js';
import { createInlineEditor } from '../core/editor.js';
import { buildPreviewMenuItems, TABLE_ITEM_PREFIX } from '../core/editor-menu-items.js';

const model = (text) => parseTableBlock(text.split('\n'));
const cells = (text) => {
  const m = model(text);
  return [m.header, ...m.rows];
};

// Outer pipes on every line, not aligned: edited minimally.
const piped = '| a | b |\n|---|:-:|\n| 1 | 2 |\n| 3 | 4 |';
// Aligned: stays aligned.
const aligned = formatTableText(model(piped));
// No outer pipes: re-formatted (an empty edge cell can't be written without them).
const bare = 'a | b\n--- | ---\n1 | 2';

describe('applyTableOp: rows', () => {
  it('inserts an empty row below a body row, touching no other line', () => {
    const r = applyTableOp(piped, 'row-below', 1, 1);
    const lines = r.text.split('\n');
    expect(lines).toHaveLength(5);
    expect(lines.filter((_, i) => i !== 3)).toEqual(piped.split('\n'));
    expect(cells(r.text)[2]).toEqual(['', '']);
    expect(r).toMatchObject({ row: 2, col: 1 });
  });

  it('inserts above a body row', () => {
    const r = applyTableOp(piped, 'row-above', 2, 0);
    expect(cells(r.text).map((c) => c[0])).toEqual(['a', '1', '', '3']);
    expect(r).toMatchObject({ row: 2, col: 0 });
  });

  it('"below the header" is the first body row; there is nothing above it', () => {
    const r = applyTableOp(piped, 'row-below', 0, 0);
    expect(cells(r.text).map((c) => c[0])).toEqual(['a', '', '1', '3']);
    expect(r.row).toBe(1);
    expect(applyTableOp(piped, 'row-above', 0, 0)).toBeNull();
  });

  it('adds a row after the last one (the "+" button / Tab at the end)', () => {
    const r = applyTableOp(piped, 'row-below', 2, 0);
    expect(cells(r.text).map((c) => c[0])).toEqual(['a', '1', '3', '']);
    expect(r.row).toBe(3);
  });

  it('adds a row to a header-only table', () => {
    const r = applyTableOp('| a | b |\n|---|---|', 'row-below', 0, 1);
    expect(cells(r.text)).toEqual([
      ['a', 'b'],
      ['', ''],
    ]);
  });

  it('keeps an aligned table aligned', () => {
    const r = applyTableOp(aligned, 'row-below', 1, 0);
    expect(r.text).toBe(formatTableText(model(r.text)));
    expect(model(r.text).align).toEqual(model(aligned).align);
  });

  it('re-formats a table without outer pipes', () => {
    const r = applyTableOp(bare, 'row-below', 1, 0);
    expect(cells(r.text)).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['', ''],
    ]);
  });

  it('deletes a body row by dropping just its line', () => {
    const r = applyTableOp(piped, 'row-delete', 1, 1);
    expect(r.text).toBe('| a | b |\n|---|:-:|\n| 3 | 4 |');
    expect(r).toMatchObject({ row: 1, col: 1 });
  });

  it('after deleting the last row, continues on the row above', () => {
    expect(applyTableOp(piped, 'row-delete', 2, 0).row).toBe(1);
    expect(applyTableOp('| a |\n|---|\n| 1 |', 'row-delete', 1, 0)).toMatchObject({
      text: '| a |\n|---|',
      row: 0,
    });
  });

  it('re-aligns an aligned table after deleting its widest row', () => {
    const t = formatTableText(model('| a | b |\n|---|---|\n| very wide | 2 |\n| 3 | 4 |'));
    const r = applyTableOp(t, 'row-delete', 1, 0);
    expect(r.text).toBe(formatTableText(model(r.text)));
    expect(r.text).not.toContain('very wide');
  });

  it('does not delete the header row', () => {
    expect(applyTableOp(piped, 'row-delete', 0, 0)).toBeNull();
  });
});

describe('applyTableOp: columns', () => {
  it('inserts a column to the right, minimally, with a separator cell', () => {
    const r = applyTableOp(piped, 'col-right', 1, 0);
    expect(r.text.split('\n')).toEqual([
      '| a |  | b |',
      '|---| --- |:-:|',
      '| 1 |  | 2 |',
      '| 3 |  | 4 |',
    ]);
    expect(r).toMatchObject({ row: 1, col: 1 });
    expect(model(r.text).align).toEqual([null, null, 'center']);
  });

  it('inserts a column to the left of the first one', () => {
    const r = applyTableOp(piped, 'col-left', 0, 0);
    expect(cells(r.text)).toEqual([
      ['', 'a', 'b'],
      ['', '1', '2'],
      ['', '3', '4'],
    ]);
    expect(r).toMatchObject({ row: 0, col: 0 });
  });

  it('appends a column after the last one', () => {
    const r = applyTableOp(piped, 'col-right', 0, 1);
    expect(cells(r.text)).toEqual([
      ['a', 'b', ''],
      ['1', '2', ''],
      ['3', '4', ''],
    ]);
    expect(r.col).toBe(2);
  });

  it('keeps an aligned table aligned and its alignment markers in place', () => {
    const r = applyTableOp(aligned, 'col-left', 0, 1);
    expect(r.text).toBe(formatTableText(model(r.text)));
    expect(model(r.text).align).toEqual([null, null, 'center']);
  });

  it('re-formats a table without outer pipes so the empty edge cell survives', () => {
    for (const [op, col, at] of [
      ['col-left', 0, 0],
      ['col-right', 1, 2],
    ]) {
      const r = applyTableOp(bare, op, 0, col);
      expect(model(r.text).header).toHaveLength(3);
      expect(model(r.text).header[at]).toBe('');
    }
  });

  it('leaves a short row short (its missing cells are already empty)', () => {
    const ragged = '| a | b | c |\n|---|---|---|\n| 1 |';
    const r = applyTableOp(ragged, 'col-right', 0, 2);
    expect(r.text.split('\n')[2]).toBe('| 1 |');
    expect(cells(r.text)[1]).toEqual(['1', '', '', '']);
  });

  it('does not split on pipes inside code spans or escapes', () => {
    const t = '| `x|y` | a\\|b |\n|---|---|\n| 1 | 2 |';
    const r = applyTableOp(t, 'col-right', 0, 0);
    expect(cells(r.text)[0]).toEqual(['`x|y`', '', 'a\\|b']);
  });

  it('deletes a column with one of its pipes', () => {
    expect(applyTableOp(piped, 'col-delete', 1, 0).text).toBe('| b |\n|:-:|\n| 2 |\n| 4 |');
    const last = applyTableOp(piped, 'col-delete', 1, 1);
    expect(last.text).toBe('| a |\n|---|\n| 1 |\n| 3 |');
    expect(last.col).toBe(0);
  });

  it('deletes a column of an aligned or pipe-less table by re-formatting', () => {
    const r = applyTableOp(aligned, 'col-delete', 0, 0);
    expect(r.text).toBe(formatTableText(model(r.text)));
    expect(model(r.text).align).toEqual(['center']);
    expect(cells(applyTableOp(bare, 'col-delete', 0, 1).text)).toEqual([['a'], ['1']]);
  });

  it('does not delete the only column', () => {
    expect(applyTableOp('| a |\n|---|\n| 1 |', 'col-delete', 0, 0)).toBeNull();
  });
});

describe('applyTableOp: guards', () => {
  it('rejects non-tables, cells outside the table and unknown ops', () => {
    expect(applyTableOp('just text', 'row-below', 0, 0)).toBeNull();
    expect(applyTableOp(piped, 'row-below', 3, 0)).toBeNull();
    expect(applyTableOp(piped, 'row-below', 0, 2)).toBeNull();
    expect(applyTableOp(piped, 'row-below', -1, 0)).toBeNull();
    expect(applyTableOp(piped, 'col-left', 0, 1.5)).toBeNull();
    expect(applyTableOp(piped, 'explode', 0, 0)).toBeNull();
  });

  it('every op yields a valid table of the expected size', () => {
    for (const op of TABLE_OPS) {
      for (const src of [piped, aligned, bare]) {
        const r = applyTableOp(src, op, 1, 0);
        const m = model(r.text);
        expect(m).not.toBeNull();
        const dr = { 'row-above': 1, 'row-below': 1, 'row-delete': -1 }[op] || 0;
        const dc = { 'col-left': 1, 'col-right': 1, 'col-delete': -1 }[op] || 0;
        expect(m.rows.length).toBe(model(src).rows.length + dr);
        expect(m.header.length).toBe(model(src).header.length + dc);
      }
    }
  });
});

describe('tableOpsAvailable', () => {
  it('matches what applyTableOp accepts', () => {
    expect(tableOpsAvailable({ rows: 3, cols: 2 }, 0)).toMatchObject({
      'row-above': false,
      'row-delete': false,
      'col-delete': true,
    });
    expect(tableOpsAvailable({ rows: 3, cols: 1 }, 1)).toMatchObject({
      'row-above': true,
      'row-delete': true,
      'col-delete': false,
    });
  });
});

describe('preview table "+" buttons', () => {
  let container;
  afterEach(() => {
    container?.parentElement?.remove();
    container = null;
  });

  function setup(md) {
    const pane = document.createElement('div');
    container = document.createElement('div');
    pane.appendChild(container);
    document.body.appendChild(pane);
    renderMarkdown(md, '', container);
    // jsdom does no layout: give the preview and its tables a box.
    const box = (left, top, right, bottom) => () => ({ left, top, right, bottom });
    container.getBoundingClientRect = box(0, 0, 500, 400);
    for (const t of container.querySelectorAll('table'))
      t.getBoundingClientRect = box(20, 50, 480, 150);
    const onOp = vi.fn();
    const buttons = attachTableControls(container, onOp);
    return { onOp, buttons };
  }

  const hover = (el) => el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));

  it('finds only top-level tables', () => {
    setup('| a |\n|---|\n| 1 |\n\n> | q |\n> |---|\n> | 1 |\n');
    const [top, nested] = container.querySelectorAll('table');
    expect(hoveredTable(container, top.querySelector('td'))).toMatchObject({ table: top, line: 1 });
    expect(hoveredTable(container, nested.querySelector('td'))).toBeNull();
    expect(hoveredTable(container, container)).toBeNull();
  });

  it('counts rendered rows (with the header) and columns', () => {
    setup('| a | b | c |\n|---|---|---|\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n');
    expect(renderedTableSize(container.querySelector('table'))).toEqual({ rows: 3, cols: 3 });
  });

  it('shows on a table, hides elsewhere', () => {
    const { buttons } = setup('para\n\n| a |\n|---|\n| 1 |\n');
    hover(container.querySelector('td'));
    expect(buttons.row.hidden).toBe(false);
    expect(buttons.col.hidden).toBe(false);
    expect(buttons.row.classList.contains(TABLE_ADD_CLASS)).toBe(true);
    // Beside the container, not in it (preview-blocks counts its children).
    expect(buttons.row.parentElement).toBe(container.parentElement);
    expect([buttons.row.style.left, buttons.row.style.top]).toEqual(['250px', '150px']);
    expect([buttons.col.style.left, buttons.col.style.top]).toEqual(['480px', '100px']);
    hover(container.querySelector('p'));
    expect(buttons.row.hidden).toBe(true);
    expect(buttons.col.hidden).toBe(true);
  });

  it('adds a row after the last one / a column after the last one', () => {
    const { onOp, buttons } = setup('text\n\n| a | b |\n|---|---|\n| 1 | 2 |\n');
    hover(container.querySelector('td'));
    buttons.row.click();
    expect(onOp).toHaveBeenLastCalledWith({ container, line: 3, op: 'row-below', row: 1, col: 0 });
    hover(container.querySelector('td'));
    buttons.col.click();
    expect(onOp).toHaveBeenLastCalledWith({ container, line: 3, op: 'col-right', row: 0, col: 1 });
  });

  it('does nothing in a whole-file diagram', () => {
    const { buttons } = setup('| a |\n|---|\n');
    container.dataset.wholeFile = '1';
    hover(container.querySelector('th'));
    expect(buttons.row.hidden).toBe(true);
  });
});

describe('tableButtonPositions', () => {
  const view = { left: 0, right: 500, top: 0, bottom: 400 };

  it('centres the buttons on the bottom and right edges', () => {
    const p = tableButtonPositions({ left: 100, right: 300, top: 50, bottom: 150 }, view);
    expect(p.row).toEqual({ x: 200, y: 150 });
    expect(p.col).toEqual({ x: 300, y: 100 });
  });

  it('hides the row button when the bottom edge is out of sight', () => {
    const p = tableButtonPositions({ left: 0, right: 300, top: 100, bottom: 900 }, view);
    expect(p.row).toBeNull();
    // The column button stays on the visible part of the right edge.
    expect(p.col.y).toBe(250);
  });

  it('keeps the buttons inside the preview', () => {
    const p = tableButtonPositions({ left: 0, right: 800, top: 300, bottom: 399 }, view);
    expect(p.col.x).toBeLessThanOrEqual(500);
    expect(p.row.y).toBeLessThanOrEqual(400);
  });

  it('nothing for a table scrolled out of sight', () => {
    expect(tableButtonPositions({ left: 0, right: 100, top: 500, bottom: 600 }, view)).toEqual({
      row: null,
      col: null,
    });
  });
});

describe('cell editor: table operation keys', () => {
  afterEach(() => cancelInlineEdit());

  function keydown(view, init) {
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
    );
  }

  it('Ctrl+Enter / Ctrl+Shift+Enter / Ctrl+Alt+→ / ← ask for row and column inserts', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const tableOp = vi.fn();
    const commit = vi.fn();
    const view = createInlineEditor(parent, 'x', { commit, tableOp }, 0, { singleLine: true });
    keydown(view, { key: 'Enter', ctrlKey: true });
    keydown(view, { key: 'Enter', ctrlKey: true, shiftKey: true });
    keydown(view, { key: 'ArrowRight', ctrlKey: true, altKey: true });
    keydown(view, { key: 'ArrowLeft', ctrlKey: true, altKey: true });
    expect(tableOp.mock.calls).toEqual([['row-below'], ['row-above'], ['col-right'], ['col-left']]);
    expect(commit).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe('x');
    view.destroy();
    parent.remove();
  });

  it('without table support, Ctrl+Enter still just finishes', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const commit = vi.fn();
    const view = createInlineEditor(parent, 'x', { commit }, 0, { singleLine: true });
    keydown(view, { key: 'Enter', ctrlKey: true });
    expect(commit).toHaveBeenCalledTimes(1);
    view.destroy();
    parent.remove();
  });

  it('commits the cell first, restores it, then runs the operation', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    renderMarkdown('| a | b |\n|---|---|\n', '', container);
    const table = container.querySelector('table');
    const th = table.querySelector('th');
    const order = [];
    let handlers;
    startInlineEdit({
      container,
      blockEl: table,
      cellEl: th,
      text: 'a',
      mountEditor: (host, text, h) => {
        handlers = h;
        return { state: { doc: { toString: () => 'A' } }, destroy: () => {} };
      },
      onCommit: (t) => order.push(['commit', t, th.textContent]),
      onTableOp: (op) => order.push(['op', op]),
    });
    handlers.tableOp('row-below');
    expect(order).toEqual([
      ['commit', 'A', 'a'],
      ['op', 'row-below'],
    ]);
    container.remove();
  });

  it('a cell edit without onTableOp offers no tableOp handler', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    renderMarkdown('| a |\n|---|\n', '', container);
    let handlers;
    startInlineEdit({
      container,
      blockEl: container.querySelector('table'),
      cellEl: container.querySelector('th'),
      text: 'a',
      mountEditor: (host, text, h) => {
        handlers = h;
        return { state: { doc: { toString: () => 'a' } }, destroy: () => {} };
      },
      onCommit: () => {},
    });
    expect(handlers.tableOp).toBeUndefined();
    container.remove();
  });
});

describe('buildPreviewMenuItems: table cell', () => {
  const ids = (items) => items.filter((i) => !i.separator).map((i) => i.id);
  const byId = (items, id) => items.find((i) => i.id === id);

  it('offers no table items outside a table', () => {
    expect(ids(buildPreviewMenuItems({ hasSelection: false }))).toEqual(['copy']);
  });

  it('offers every operation on a body cell, named by its op', () => {
    const items = buildPreviewMenuItems({
      hasSelection: false,
      tableCell: { row: 1, size: { rows: 3, cols: 2 } },
    });
    const tableIds = ids(items).filter((id) => id.startsWith(TABLE_ITEM_PREFIX));
    expect(tableIds.map((id) => id.slice(TABLE_ITEM_PREFIX.length))).toEqual(TABLE_OPS);
    expect(items.filter((i) => i.disabled && i.id !== 'copy')).toEqual([]);
  });

  it('disables what does not apply to the header row or a one-column table', () => {
    const items = buildPreviewMenuItems({
      hasSelection: true,
      tableCell: { row: 0, size: { rows: 1, cols: 1 } },
    });
    expect(byId(items, 'table-row-above').disabled).toBe(true);
    expect(byId(items, 'table-row-delete').disabled).toBe(true);
    expect(byId(items, 'table-col-delete').disabled).toBe(true);
    expect(byId(items, 'table-row-below').disabled).toBeFalsy();
    expect(byId(items, 'copy').disabled).toBe(false);
  });
});
