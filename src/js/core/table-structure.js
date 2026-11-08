// table-structure.js - add and remove rows and columns of a Markdown table's
// source.
//
// Used by the preview, where a table is edited cell by cell: the "+" buttons on
// a table's edges, the right-click menu on a cell, and the keys of the cell
// editor (Ctrl+Enter etc.) all end up here, as "apply this operation at cell
// (row, col)".
//
// Like table-cell-edit.js it keeps the author's style. An aligned table (what
// formatTable would produce) stays aligned. A table written with outer pipes on
// every line gets a minimal edit: only the inserted or removed cells change.
// Anything else is re-formatted, because a table without outer pipes cannot
// hold an empty first or last cell — GFM reads a pipe at either end of a line
// as the optional outer pipe, so the new empty cell would vanish.

import { parseTableBlock, formatTableText } from './table.js';
import { cellSpans } from './table-cell-edit.js';

/** Operations, as named by the menu and the keys. */
export const TABLE_OPS = [
  'row-above',
  'row-below',
  'col-left',
  'col-right',
  'row-delete',
  'col-delete',
];

/** True if every line has a pipe at both ends (ignoring surrounding spaces). */
function fullyPiped(lines) {
  return lines.every((l) => {
    const t = l.trim();
    return t.length >= 2 && t.startsWith('|') && t.endsWith('|');
  });
}

/** An empty row for a table with `n` columns, in the outer-pipe style. */
function blankRowLine(n) {
  return `|${'  |'.repeat(n)}`;
}

/** Insert an empty cell before column `col` (or after the last, col = count). */
function insertCellInLine(line, col, content) {
  const spans = cellSpans(line);
  if (spans.length === 0 || col > spans.length) return line; // short row: nothing to add
  const cell = content ? ` ${content} ` : '  ';
  if (col < spans.length) {
    const at = spans[col].segFrom;
    return line.slice(0, at) + cell + '|' + line.slice(at);
  }
  const at = spans[spans.length - 1].segTo;
  return line.slice(0, at) + '|' + cell + line.slice(at);
}

/** Remove the cell of column `col` together with one of its pipes. */
function deleteCellInLine(line, col) {
  const spans = cellSpans(line);
  if (col >= spans.length) return line; // short row: the cell isn't written
  if (col + 1 < spans.length) {
    return line.slice(0, spans[col].segFrom) + line.slice(spans[col + 1].segFrom);
  }
  if (col === 0) return line; // a one-cell row; the caller never gets here
  return line.slice(0, spans[col - 1].segTo) + line.slice(spans[col].segTo);
}

/**
 * Apply a structural operation to a table at cell (row, col).
 *
 * @param {string} tableText the table's source lines (header, separator, rows)
 * @param {string} op one of TABLE_OPS
 * @param {number} row the cell the operation is relative to; 0 = header row,
 *   body rows count from 1
 * @param {number} col 0-based column
 * @returns {{text: string, row: number, col: number} | null} the table's new
 *   source, and the cell to continue in (the new one, for an insert; the one
 *   now in the removed one's place, for a delete). Null when the operation
 *   doesn't apply: not a table, a cell outside it, a row above or in place of
 *   the header, or removing the only column.
 */
export function applyTableOp(tableText, op, row, col) {
  const lines = tableText.split('\n');
  const model = parseTableBlock(lines);
  if (!model) return null;
  const cols = model.header.length;
  const bodyRows = model.rows.length;
  if (!Number.isInteger(row) || !Number.isInteger(col)) return null;
  if (row < 0 || row > bodyRows || col < 0 || col >= cols) return null;

  const wasAligned = formatTableText(model) === tableText;
  const minimal = !wasAligned && fullyPiped(lines);

  switch (op) {
    case 'row-above':
    case 'row-below': {
      // A new row goes into the body: there is no row above the header, and
      // "below the header" is the first body row.
      if (op === 'row-above' && row === 0) return null;
      const newRow = op === 'row-above' ? row : row + 1;
      // Body row r sits on line r + 1 (line 0 header, line 1 separator).
      const lineIndex = newRow + 1;
      if (minimal) {
        lines.splice(lineIndex, 0, blankRowLine(cols));
        return { text: lines.join('\n'), row: newRow, col };
      }
      model.rows.splice(newRow - 1, 0, new Array(cols).fill(''));
      return { text: formatTableText(model), row: newRow, col };
    }

    case 'col-left':
    case 'col-right': {
      const at = op === 'col-left' ? col : col + 1;
      if (minimal) {
        const out = lines.map((l, i) => insertCellInLine(l, at, i === 1 ? '---' : ''));
        return { text: out.join('\n'), row, col: at };
      }
      model.header.splice(at, 0, '');
      model.align.splice(at, 0, null);
      for (const r of model.rows) r.splice(at, 0, '');
      return { text: formatTableText(model), row, col: at };
    }

    case 'row-delete': {
      if (row === 0) return null; // the header can't go: it is what makes a table
      const next = Math.min(row, bodyRows - 1);
      if (!wasAligned) {
        // Dropping a line is a minimal edit whatever the style. An aligned
        // table is re-formatted instead: the row may have been the widest.
        lines.splice(row + 1, 1);
        return { text: lines.join('\n'), row: next, col };
      }
      model.rows.splice(row - 1, 1);
      return { text: formatTableText(model), row: next, col };
    }

    case 'col-delete': {
      if (cols <= 1) return null;
      const next = Math.min(col, cols - 2);
      if (minimal) {
        const out = lines.map((l) => deleteCellInLine(l, col));
        return { text: out.join('\n'), row, col: next };
      }
      model.header.splice(col, 1);
      model.align.splice(col, 1);
      for (const r of model.rows) r.splice(col, 1);
      return { text: formatTableText(model), row, col: next };
    }

    default:
      return null;
  }
}

/**
 * Which operations apply at a cell, for enabling menu items.
 * @param {{rows: number, cols: number}} size rows including the header
 * @param {number} row
 * @returns {Record<string, boolean>}
 */
export function tableOpsAvailable(size, row) {
  return {
    'row-above': row > 0,
    'row-below': true,
    'col-left': true,
    'col-right': true,
    'row-delete': row > 0,
    'col-delete': size.cols > 1,
  };
}
