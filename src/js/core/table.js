// table.js - Pure helpers for Markdown (GFM) table editing.
//
// Everything here is string<->model transformation with no DOM/CodeMirror
// dependency, so it is fully unit-testable. The editor layer (editor.js) wires
// these into keymaps and the paste handler.
//
// Model shape:
//   { header: string[], align: (null|'left'|'center'|'right')[], rows: string[][] }

// Minimum column content width so a separator always has at least "---".
const MIN_COL_WIDTH = 3;

/**
 * Display width of a single code point. CJK / fullwidth characters occupy two
 * terminal/monospace columns; everything else one. Emoji are approximated as
 * width 1 (a known limitation).
 */
function charWidth(cp) {
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK radicals .. Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compat forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth signs
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji & symbols (treat as wide)
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Ext B+
  ) {
    return 2;
  }
  return 1;
}

/** Monospace display width of a string (CJK-aware). */
export function displayWidth(str) {
  let w = 0;
  for (const ch of String(str)) {
    w += charWidth(ch.codePointAt(0));
  }
  return w;
}

/**
 * Split a table row line into trimmed cell strings. Respects backslash-escaped
 * pipes (`\|`) and pipes inside inline code spans (`` `a|b` ``). Outer leading
 * and trailing pipes are dropped.
 */
export function splitRow(line) {
  const cells = [];
  let cur = '';
  let inCode = false;
  let escaped = false;
  for (const ch of line) {
    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      cur += ch;
      escaped = true;
      continue;
    }
    if (ch === '`') {
      inCode = !inCode;
      cur += ch;
      continue;
    }
    if (ch === '|' && !inCode) {
      cells.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  // Drop the empty fragments produced by the optional outer pipes.
  if (cells.length && cells[0].trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((c) => c.trim());
}

/** True if every cell of `line` is a separator token like `---`, `:--`, `:-:`. */
export function isSeparatorLine(line) {
  if (!line.includes('-')) return false;
  const cells = splitRow(line);
  if (cells.length === 0) return false;
  return cells.every((c) => /^:?-+:?$/.test(c));
}

function alignOf(cell) {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

function padCell(content, width, align) {
  const pad = Math.max(0, width - displayWidth(content));
  if (align === 'right') return ' '.repeat(pad) + content;
  if (align === 'center') {
    const l = Math.floor(pad / 2);
    return ' '.repeat(l) + content + ' '.repeat(pad - l);
  }
  return content + ' '.repeat(pad); // left / none
}

function separatorCell(width, align) {
  const w = Math.max(MIN_COL_WIDTH, width);
  if (align === 'center') return ':' + '-'.repeat(w - 2) + ':';
  if (align === 'right') return '-'.repeat(w - 1) + ':';
  if (align === 'left') return ':' + '-'.repeat(w - 1);
  return '-'.repeat(w);
}

/**
 * Parse a block of lines into a table model, or null when the block is not a
 * valid table (a separator row must be the second line). Ragged rows are padded
 * or truncated to the header's column count.
 */
export function parseTableBlock(lines) {
  if (!Array.isArray(lines) || lines.length < 2) return null;
  if (!isSeparatorLine(lines[1])) return null;

  const header = splitRow(lines[0]);
  const numCols = header.length;
  if (numCols === 0) return null;

  const sepCells = splitRow(lines[1]);
  const align = [];
  for (let i = 0; i < numCols; i++) align.push(alignOf(sepCells[i] || ''));

  const rows = [];
  for (let i = 2; i < lines.length; i++) {
    const cells = splitRow(lines[i]);
    const row = [];
    for (let c = 0; c < numCols; c++) row.push(cells[c] ?? '');
    rows.push(row);
  }
  return { header, align, rows };
}

/** Column content widths for a model (CJK-aware, clamped to MIN_COL_WIDTH). */
function columnWidths(model) {
  const numCols = model.header.length;
  const widths = new Array(numCols).fill(MIN_COL_WIDTH);
  const all = [model.header, ...model.rows];
  for (const row of all) {
    for (let c = 0; c < numCols; c++) {
      widths[c] = Math.max(widths[c], displayWidth(row[c] ?? ''));
    }
  }
  return widths;
}

function rowToLine(cells, widths, aligns) {
  const padded = cells.map((cell, c) => padCell(cell ?? '', widths[c], aligns[c]));
  return '| ' + padded.join(' | ') + ' |';
}

/** Render a model to aligned table lines (header, separator, ...rows). */
export function formatTable(model) {
  const widths = columnWidths(model);
  const lines = [];
  lines.push(rowToLine(model.header, widths, model.align));
  const sep = model.align.map((a, c) => separatorCell(widths[c], a));
  lines.push('| ' + sep.join(' | ') + ' |');
  for (const row of model.rows) lines.push(rowToLine(row, widths, model.align));
  return lines;
}

/** Convenience: format and join with newlines. */
export function formatTableText(model) {
  return formatTable(model).join('\n');
}

/** A blank model with the given dimensions (for grid insertion). */
export function emptyTableModel(rows, cols) {
  const c = Math.max(1, cols);
  const r = Math.max(0, rows);
  return {
    header: new Array(c).fill(''),
    align: new Array(c).fill(null),
    rows: Array.from({ length: r }, () => new Array(c).fill('')),
  };
}

function isTableish(line) {
  return line.trim() !== '' && line.includes('|');
}

/**
 * Find the table block containing 0-based `lineIndex` in `docText`. Returns
 * `{ startLine, endLine, model }` (inclusive line range) or null when the cursor
 * is not inside a valid table.
 */
export function findTableAt(docText, lineIndex) {
  const lines = docText.split('\n');
  if (lineIndex < 0 || lineIndex >= lines.length) return null;
  if (!isTableish(lines[lineIndex])) return null;

  // Expand to the contiguous run of table-ish lines around the cursor.
  let start = lineIndex;
  while (start > 0 && isTableish(lines[start - 1])) start--;
  let end = lineIndex;
  while (end < lines.length - 1 && isTableish(lines[end + 1])) end++;

  // The header is the line immediately above the first separator in the run.
  let sep = -1;
  for (let i = start; i <= end; i++) {
    if (isSeparatorLine(lines[i])) {
      sep = i;
      break;
    }
  }
  if (sep <= start) return null; // need a header line above the separator
  const headerLine = sep - 1;
  if (lineIndex < headerLine) return null; // cursor is above the table proper

  const block = lines.slice(headerLine, end + 1);
  const model = parseTableBlock(block);
  if (!model) return null;
  return { startLine: headerLine, endLine: end, model };
}

/**
 * Count the cell index a character column falls into on a table row line,
 * honouring escapes and inline code (same rules as splitRow). `colInLine` is a
 * 0-based character offset within the line.
 */
export function cellIndexInLine(line, colInLine) {
  let idx = 0;
  let inCode = false;
  let escaped = false;
  let sawContent = false;
  let firstPipeSeen = false;
  for (let i = 0; i < colInLine && i < line.length; i++) {
    const ch = line[i];
    if (escaped) {
      escaped = false;
      sawContent = true;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '`') {
      inCode = !inCode;
      continue;
    }
    if (ch === '|' && !inCode) {
      // A leading pipe (before any content) opens cell 0 rather than advancing.
      if (!firstPipeSeen && !sawContent) {
        firstPipeSeen = true;
        continue;
      }
      idx++;
      continue;
    }
    if (ch !== ' ') sawContent = true;
  }
  return idx;
}

/** 0-based character column where cell `cellIdx` content starts on a formatted line. */
export function cellStartColumn(formattedLine, cellIdx) {
  // Formatted lines look like "| c0 | c1 | ... |"; content starts 2 chars after
  // the opening pipe of the target cell.
  let pipes = 0;
  for (let i = 0; i < formattedLine.length; i++) {
    if (formattedLine[i] === '|') {
      if (pipes === cellIdx) return Math.min(i + 2, formattedLine.length);
      pipes++;
    }
  }
  return formattedLine.length;
}

/**
 * Compute the result of moving the cursor within a table block. Pure: takes the
 * block text and a cursor offset within it, returns the reformatted block text
 * and the new cursor offset within that text, or null when not applicable.
 *
 * direction: 'next' (Tab) | 'prev' (Shift-Tab) | 'down' (Enter).
 * At the end of the table, 'next'/'down' append a fresh empty row.
 */
export function navigateTable(blockText, cursorOffset, direction) {
  const lines = blockText.split('\n');
  const model = parseTableBlock(lines);
  if (!model) return null;
  const numCols = model.header.length;

  // Locate cursor (lineIdx, colInLine) from the offset.
  let off = 0;
  let lineIdx = 0;
  let colInLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineLen = lines[i].length;
    if (cursorOffset <= off + lineLen) {
      lineIdx = i;
      colInLine = cursorOffset - off;
      break;
    }
    off += lineLen + 1; // + newline
    lineIdx = i + 1;
  }

  // Map a block line index to an "editable row" index: 0 = header, 1.. = data
  // rows (the separator line at index 1 is skipped / treated as header).
  let editRow;
  if (lineIdx <= 1) editRow = 0;
  else editRow = lineIdx - 1;
  let cell = cellIndexInLine(lines[lineIdx] || '', colInLine);
  if (cell >= numCols) cell = numCols - 1;
  if (cell < 0) cell = 0;

  const lastEditRow = model.rows.length; // header(0) + rows(1..length)

  if (direction === 'next') {
    cell++;
    if (cell >= numCols) {
      cell = 0;
      editRow++;
    }
  } else if (direction === 'prev') {
    cell--;
    if (cell < 0) {
      cell = numCols - 1;
      editRow--;
    }
  } else if (direction === 'down') {
    editRow++;
  }

  if (editRow < 0) {
    editRow = 0;
    cell = 0;
  }
  if (editRow > lastEditRow) {
    // Append a new empty data row.
    model.rows.push(new Array(numCols).fill(''));
    editRow = model.rows.length; // the new last row
  }

  const newLines = formatTable(model);
  // editRow -> formatted line index: 0 -> 0 (header); r>=1 -> r + 1 (skip sep).
  const targetLineIdx = editRow === 0 ? 0 : editRow + 1;
  const targetCol = cellStartColumn(newLines[targetLineIdx], cell);

  let newOffset = 0;
  for (let i = 0; i < targetLineIdx; i++) newOffset += newLines[i].length + 1;
  newOffset += targetCol;

  return { text: newLines.join('\n'), cursor: newOffset };
}

// ── Delimited (TSV/CSV) paste conversion ───────────────────

/** Parse one CSV line into fields, handling quoted fields and "" escapes. */
function parseCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

/** Escape a raw cell value for use inside a Markdown table cell. */
function escapeCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
}

/**
 * Convert pasted delimited text (TSV or CSV) into a table model, or null when it
 * does not look like tabular data. Conservative to avoid mangling prose:
 *   - TSV: every line contains a tab (>= 2 columns).
 *   - CSV: >= 2 lines, every line has the same field count (>= 2 columns).
 * The first line becomes the header.
 */
export function delimitedToModel(text) {
  const raw = String(text).replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  if (raw.trim() === '') return null;
  const lines = raw.split('\n');

  // TSV first: tabs are an unambiguous signal.
  if (lines.every((l) => l.includes('\t'))) {
    const grid = lines.map((l) => l.split('\t'));
    const cols = Math.max(...grid.map((r) => r.length));
    if (cols >= 2) return gridToModel(grid, cols);
  }

  // CSV: require multiple consistent rows to avoid converting prose.
  if (lines.length >= 2) {
    const grid = lines.map(parseCsvLine);
    const cols = grid[0].length;
    if (cols >= 2 && grid.every((r) => r.length === cols)) {
      return gridToModel(grid, cols);
    }
  }
  return null;
}

function gridToModel(grid, cols) {
  const pad = (r) => {
    const row = [];
    for (let c = 0; c < cols; c++) row.push(escapeCell(r[c] ?? ''));
    return row;
  };
  const header = pad(grid[0]);
  const rows = grid.slice(1).map(pad);
  return { header, align: new Array(cols).fill(null), rows };
}
