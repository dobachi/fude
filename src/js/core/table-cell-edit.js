// table-cell-edit.js - rewrite one cell of a Markdown table's source.
//
// Used by the preview's in-place editing: double-clicking a table cell edits
// just that cell, and this module turns "cell (row, col) is now X" into the new
// source of the whole table.
//
// It keeps the author's style. A table that was aligned (exactly what
// formatTable would produce) is re-aligned after the edit, since the new text
// usually changes a column's width. Any other table gets a minimal edit: only
// the cell's characters change, every other line and cell is left alone.

import { parseTableBlock, formatTableText } from './table.js';

/**
 * Character spans of each cell's content on a table row line, following the
 * same rules as splitRow (backslash escapes; pipes inside code spans don't
 * split). `from`/`to` bound the trimmed content; for an empty cell they are an
 * empty range inside the cell. `segFrom`/`segTo` bound the whole cell between
 * its pipes.
 *
 * @param {string} line
 * @returns {Array<{from: number, to: number, segFrom: number, segTo: number}>}
 */
export function cellSpans(line) {
  const pipes = [];
  let inCode = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\') {
      i += 1; // skip the escaped character
      continue;
    }
    if (ch === '`') inCode = !inCode;
    else if (ch === '|' && !inCode) pipes.push(i);
  }

  const segments = [];
  let start = 0;
  for (const p of pipes) {
    segments.push([start, p]);
    start = p + 1;
  }
  segments.push([start, line.length]);

  // Optional outer pipes leave empty fragments at either end; drop them.
  const blank = ([a, b]) => line.slice(a, b).trim() === '';
  if (segments.length && blank(segments[0])) segments.shift();
  if (segments.length && blank(segments[segments.length - 1])) segments.pop();

  return segments.map(([segFrom, segTo]) => {
    const raw = line.slice(segFrom, segTo);
    const lead = raw.length - raw.trimStart().length;
    const content = raw.trim();
    if (!content) {
      // Empty cell: point at the middle of its whitespace (or its start).
      const at = segFrom + Math.min(1, raw.length);
      return { from: at, to: at, segFrom, segTo };
    }
    const from = segFrom + lead;
    return { from, to: from + content.length, segFrom, segTo };
  });
}

/**
 * Make free text safe as a single table cell: one line, no bare pipes.
 * Already-escaped pipes (`\|`) are kept as they are.
 * @param {string} text
 * @returns {string}
 */
export function sanitizeCell(text) {
  const flat = String(text).replace(/\r?\n/g, ' ').trim();
  let out = '';
  for (let i = 0; i < flat.length; i++) {
    const ch = flat[i];
    if (ch === '\\' && i + 1 < flat.length) {
      out += ch + flat[i + 1];
      i += 1;
      continue;
    }
    out += ch === '|' ? '\\|' : ch;
  }
  return out;
}

/**
 * The source text of one cell, as the author wrote it (trimmed).
 *
 * @param {string} tableText the table's source lines
 * @param {number} row 0 = header, 1.. = body rows
 * @param {number} col 0-based column
 * @returns {string|null} null when the table or the cell doesn't exist
 */
export function tableCellText(tableText, row, col) {
  const model = parseTableBlock(tableText.split('\n'));
  if (!model || col < 0 || col >= model.header.length) return null;
  const cells = row === 0 ? model.header : model.rows[row - 1];
  return cells ? cells[col] : null;
}

/**
 * Replace one cell of a table and return the table's new source.
 *
 * @param {string} tableText the table's source lines (header, separator, rows)
 * @param {number} row 0 = header, 1.. = body rows
 * @param {number} col 0-based column
 * @param {string} text new cell content (sanitised here)
 * @returns {string|null} null when the table or the cell doesn't exist
 */
export function editTableCell(tableText, row, col, text) {
  const lines = tableText.split('\n');
  const model = parseTableBlock(lines);
  if (!model || row < 0 || col < 0 || col >= model.header.length) return null;
  if (row > model.rows.length) return null;

  const value = sanitizeCell(text);
  const wasAligned = formatTableText(model) === tableText;

  const lineIndex = row === 0 ? 0 : row + 1; // skip the separator line
  const spans = cellSpans(lines[lineIndex]);

  if (!wasAligned && col < spans.length) {
    const { from, to, segFrom, segTo } = spans[col];
    const line = lines[lineIndex];
    // An empty cell may have no room for the text; give it one space a side.
    const edited =
      from === to && value
        ? line.slice(0, segFrom) + ` ${value} ` + line.slice(segTo)
        : line.slice(0, from) + value + line.slice(to);
    lines[lineIndex] = edited;
    return lines.join('\n');
  }

  // Aligned table (keep it aligned), or a short row that lacks this cell
  // (the model pads it; re-rendering the table is the only honest fix).
  const cells = row === 0 ? model.header : model.rows[row - 1];
  cells[col] = value;
  return formatTableText(model);
}

/**
 * The cell Tab (dir = 1) or Shift+Tab (dir = -1) moves to, reading order:
 * along the row, then on to the next/previous row. The header is row 0.
 *
 * @param {number} rows total rows including the header
 * @param {number} cols columns
 * @param {number} row
 * @param {number} col
 * @param {1|-1} dir
 * @returns {{row: number, col: number} | null} null past either end
 */
export function adjacentCell(rows, cols, row, col, dir) {
  if (rows < 1 || cols < 1) return null;
  const index = row * cols + col + dir;
  if (index < 0 || index >= rows * cols) return null;
  return { row: Math.floor(index / cols), col: index % cols };
}

/**
 * Size of a table as the preview shows it: rows including the header, and
 * columns. Null when `tableText` is not a table.
 * @returns {{rows: number, cols: number} | null}
 */
export function tableSize(tableText) {
  const model = parseTableBlock(tableText.split('\n'));
  if (!model) return null;
  return { rows: model.rows.length + 1, cols: model.header.length };
}
