import { describe, it, expect } from 'vitest';
import { sourceTableCell, applySourceTableOp } from '../core/table-source.js';
import { formatTableText, parseTableBlock } from '../core/table.js';

const DOC = ['intro', '', '| a | b |', '|---|---|', '| c | d |', '| e | f |', '', 'outro'].join(
  '\n',
);
// line indexes: 2 header, 3 separator, 4 row 1, 5 row 2
const lineOf = (doc, i) => doc.split('\n')[i];

describe('sourceTableCell', () => {
  it('maps the line to the row and the column to the cell', () => {
    expect(sourceTableCell(DOC, 2, 2)).toMatchObject({
      startLine: 2,
      endLine: 5,
      row: 0,
      col: 0,
      size: { rows: 3, cols: 2 },
    });
    expect(sourceTableCell(DOC, 4, 6)).toMatchObject({ row: 1, col: 1 });
    expect(sourceTableCell(DOC, 5, 2)).toMatchObject({ row: 2, col: 0 });
  });

  it('treats the separator line as the header row', () => {
    expect(sourceTableCell(DOC, 3, 5)).toMatchObject({ row: 0, col: 1 });
  });

  it('clamps a column past the last pipe to the last cell', () => {
    expect(sourceTableCell(DOC, 4, 999)).toMatchObject({ col: 1 });
    expect(sourceTableCell(DOC, 4, -3)).toMatchObject({ col: 0 });
  });

  it('is null outside a table', () => {
    expect(sourceTableCell(DOC, 0, 0)).toBeNull();
    expect(sourceTableCell(DOC, 1, 0)).toBeNull();
    expect(sourceTableCell(DOC, 7, 0)).toBeNull();
    expect(sourceTableCell('| not | a table |', 0, 2)).toBeNull();
    expect(sourceTableCell(DOC, 99, 0)).toBeNull();
  });
});

describe('applySourceTableOp', () => {
  const apply = (doc, r) => {
    const lines = doc.split('\n');
    lines.splice(r.startLine, r.endLine - r.startLine + 1, ...r.text.split('\n'));
    return lines.join('\n');
  };

  it('deletes the cursor row and keeps the rest of the document', () => {
    const r = applySourceTableOp(DOC, 4, 2, 'row-delete');
    const out = apply(DOC, r);
    expect(out).toBe(['intro', '', '| a | b |', '|---|---|', '| e | f |', '', 'outro'].join('\n'));
    // the cursor stays in the row now in the removed one's place
    expect(lineOf(out, r.cursorLine)).toBe('| e | f |');
    expect(lineOf(out, r.cursorLine)[r.cursorCol]).toBe('e');
  });

  it('deletes the last row and lands on the new last row', () => {
    const r = applySourceTableOp(DOC, 5, 2, 'row-delete');
    const out = apply(DOC, r);
    expect(lineOf(out, r.cursorLine)).toBe('| c | d |');
  });

  it('deletes the cursor column', () => {
    const r = applySourceTableOp(DOC, 4, 6, 'col-delete');
    const out = apply(DOC, r);
    expect(out).toBe(['intro', '', '| a |', '|---|', '| c |', '| e |', '', 'outro'].join('\n'));
    expect(lineOf(out, r.cursorLine)[r.cursorCol]).toBe('c');
  });

  it('inserts a row below / above and puts the cursor in the new row', () => {
    const below = applySourceTableOp(DOC, 4, 2, 'row-below');
    let out = apply(DOC, below);
    expect(out.split('\n').slice(2, 7)).toEqual([
      '| a | b |',
      '|---|---|',
      '| c | d |',
      '|  |  |',
      '| e | f |',
    ]);
    expect(below.cursorLine).toBe(5);
    const above = applySourceTableOp(DOC, 4, 2, 'row-above');
    out = apply(DOC, above);
    expect(lineOf(out, 4)).toBe('|  |  |');
    expect(above.cursorLine).toBe(4);
  });

  it('inserts a column and puts the cursor in it', () => {
    const r = applySourceTableOp(DOC, 4, 2, 'col-right');
    const out = apply(DOC, r);
    expect(lineOf(out, 2)).toBe('| a |  | b |');
    expect(r.cursorLine).toBe(4);
    // cursor inside the new (empty) second cell
    const line = lineOf(out, 4);
    expect(line.slice(0, r.cursorCol)).toMatch(/^\| c \| ?$/);
  });

  it('refuses what does not apply', () => {
    expect(applySourceTableOp(DOC, 2, 2, 'row-delete')).toBeNull(); // header
    expect(applySourceTableOp(DOC, 2, 2, 'row-above')).toBeNull();
    expect(applySourceTableOp('| a |\n|---|\n| b |', 2, 2, 'col-delete')).toBeNull(); // only column
    expect(applySourceTableOp(DOC, 0, 0, 'row-delete')).toBeNull(); // outside
    expect(applySourceTableOp(DOC, 4, 2, 'bogus')).toBeNull();
  });

  it('keeps an aligned table aligned', () => {
    const fmt = (lines) => formatTableText(parseTableBlock(lines));
    const doc = fmt(['| name | x |', '|---|---|', '| alpha | 1 |', '| b | 2 |']);
    const r = applySourceTableOp(doc, 2, 3, 'row-delete');
    expect(r.text).toBe(fmt(['| name | x |', '|---|---|', '| b | 2 |']));
    expect(r.text).not.toContain('alpha');
  });
});
