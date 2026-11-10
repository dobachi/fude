// table-source.js - add and remove rows and columns of a table from the
// editor (source) side.
//
// The preview already does this cell by cell (table-structure.js). Here the
// cell is found from the cursor in the Markdown source instead: the line gives
// the row, the character column gives the cell. The edit itself is the same
// applyTableOp, so both sides keep the author's style the same way.

import { findTableAt, cellIndexInLine } from './table.js';
import { applyTableOp } from './table-structure.js';
import { cellSpans } from './table-cell-edit.js';

/**
 * The table cell at a position in the source.
 *
 * @param {string} docText
 * @param {number} lineIndex 0-based line
 * @param {number} colInLine 0-based character column within the line
 * @returns {{startLine: number, endLine: number, row: number, col: number,
 *   size: {rows: number, cols: number}} | null} row 0 is the header (the
 *   separator line counts as the header too); body rows count from 1. Null
 *   outside a table.
 */
export function sourceTableCell(docText, lineIndex, colInLine) {
  const table = findTableAt(docText, lineIndex);
  if (!table) return null;
  const { startLine, endLine, model } = table;
  const offset = lineIndex - startLine;
  const row = offset <= 1 ? 0 : offset - 1;
  const cols = model.header.length;
  const line = docText.split('\n')[lineIndex];
  const col = Math.min(Math.max(0, cellIndexInLine(line, Math.max(0, colInLine))), cols - 1);
  return { startLine, endLine, row, col, size: { rows: model.rows.length + 1, cols } };
}

/**
 * Apply a row/column operation at a source position.
 *
 * @param {string} docText
 * @param {number} lineIndex
 * @param {number} colInLine
 * @param {string} op one of TABLE_OPS
 * @returns {{startLine: number, endLine: number, text: string,
 *   cursorLine: number, cursorCol: number} | null} the table's line range to
 *   replace (inclusive, in the old document), its new text, and where to put
 *   the cursor afterwards (in the new document). Null when the operation
 *   doesn't apply.
 */
export function applySourceTableOp(docText, lineIndex, colInLine, op) {
  const cell = sourceTableCell(docText, lineIndex, colInLine);
  if (!cell) return null;
  const lines = docText.split('\n');
  const original = lines.slice(cell.startLine, cell.endLine + 1).join('\n');
  const result = applyTableOp(original, op, cell.row, cell.col);
  if (!result) return null;
  const newLines = result.text.split('\n');
  // Header on the first line, body row r on line r + 1 (after the separator).
  const rel = result.row === 0 ? 0 : result.row + 1;
  const target = newLines[Math.min(rel, newLines.length - 1)] || '';
  const spans = cellSpans(target);
  const span = spans[Math.min(result.col, spans.length - 1)];
  return {
    startLine: cell.startLine,
    endLine: cell.endLine,
    text: result.text,
    cursorLine: cell.startLine + Math.min(rel, newLines.length - 1),
    cursorCol: span ? span.from : 0,
  };
}
