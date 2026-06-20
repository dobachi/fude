import { describe, it, expect } from 'vitest';
import {
  displayWidth,
  splitRow,
  isSeparatorLine,
  parseTableBlock,
  formatTable,
  formatTableText,
  emptyTableModel,
  findTableAt,
  cellIndexInLine,
  navigateTable,
  delimitedToModel,
} from '../core/table.js';

describe('displayWidth', () => {
  it('counts ASCII as 1', () => {
    expect(displayWidth('abc')).toBe(3);
  });
  it('counts CJK as 2', () => {
    expect(displayWidth('名前')).toBe(4);
    expect(displayWidth('歳')).toBe(2);
  });
  it('handles mixed strings', () => {
    expect(displayWidth('a名b')).toBe(4);
  });
});

describe('splitRow', () => {
  it('splits a basic row dropping outer pipes', () => {
    expect(splitRow('| a | b |')).toEqual(['a', 'b']);
  });
  it('keeps escaped pipes inside a cell', () => {
    expect(splitRow('| a \\| b | c |')).toEqual(['a \\| b', 'c']);
  });
  it('keeps pipes inside inline code', () => {
    expect(splitRow('| `a|b` | c |')).toEqual(['`a|b`', 'c']);
  });
  it('handles rows without outer pipes', () => {
    expect(splitRow('a | b')).toEqual(['a', 'b']);
  });
});

describe('isSeparatorLine', () => {
  it('detects plain and aligned separators', () => {
    expect(isSeparatorLine('| --- | --- |')).toBe(true);
    expect(isSeparatorLine('| :-- | :-: | --: |')).toBe(true);
  });
  it('rejects non-separators', () => {
    expect(isSeparatorLine('| a | b |')).toBe(false);
    expect(isSeparatorLine('plain text')).toBe(false);
  });
});

describe('parseTableBlock', () => {
  it('parses header, alignment and rows', () => {
    const model = parseTableBlock(['| a | b | c |', '| :-- | :-: | --: |', '| 1 | 2 | 3 |']);
    expect(model.header).toEqual(['a', 'b', 'c']);
    expect(model.align).toEqual(['left', 'center', 'right']);
    expect(model.rows).toEqual([['1', '2', '3']]);
  });
  it('pads and truncates ragged rows to header width', () => {
    const model = parseTableBlock(['| a | b |', '| --- | --- |', '| 1 |', '| 1 | 2 | 3 |']);
    expect(model.rows).toEqual([
      ['1', ''],
      ['1', '2'],
    ]);
  });
  it('returns null without a separator line', () => {
    expect(parseTableBlock(['| a | b |', '| 1 | 2 |'])).toBeNull();
  });
});

describe('formatTable', () => {
  it('aligns columns (ASCII)', () => {
    const model = parseTableBlock(['| a | bb |', '| --- | --- |', '| ccc | d |']);
    expect(formatTable(model)).toEqual(['| a   | bb  |', '| --- | --- |', '| ccc | d   |']);
  });
  it('aligns columns with CJK width', () => {
    const model = parseTableBlock(['| 名前 | 歳 |', '| --- | --- |', '| 田中 | 30 |']);
    expect(formatTable(model)).toEqual(['| 名前 | 歳  |', '| ---- | --- |', '| 田中 | 30  |']);
  });
  it('preserves alignment markers in the separator', () => {
    const model = parseTableBlock(['| a | b | c |', '| :-- | :-: | --: |', '| 1 | 2 | 3 |']);
    expect(formatTable(model)[1]).toBe('| :-- | :-: | --: |');
  });
});

describe('emptyTableModel', () => {
  it('builds a blank skeleton that formats cleanly', () => {
    const text = formatTableText(emptyTableModel(1, 2));
    expect(text).toBe('|     |     |\n| --- | --- |\n|     |     |');
  });
});

describe('findTableAt', () => {
  const doc = ['para', '', '| a | b |', '| --- | --- |', '| 1 | 2 |', '', 'after'].join('\n');
  it('finds the block from a data row', () => {
    const res = findTableAt(doc, 4);
    expect(res).not.toBeNull();
    expect(res.startLine).toBe(2);
    expect(res.endLine).toBe(4);
    expect(res.model.header).toEqual(['a', 'b']);
  });
  it('finds the block from the header line', () => {
    expect(findTableAt(doc, 2).startLine).toBe(2);
  });
  it('returns null outside a table', () => {
    expect(findTableAt(doc, 0)).toBeNull();
    expect(findTableAt(doc, 6)).toBeNull();
  });
});

describe('cellIndexInLine', () => {
  const line = '| a | b | c |';
  it('maps a column to a cell index', () => {
    expect(cellIndexInLine(line, 2)).toBe(0); // on "a"
    expect(cellIndexInLine(line, 6)).toBe(1); // on "b"
    expect(cellIndexInLine(line, 10)).toBe(2); // on "c"
  });
});

describe('navigateTable', () => {
  const block = ['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n');

  it('Tab moves to the next cell and reformats', () => {
    const res = navigateTable(block, 2, 'next'); // cursor on "a"
    expect(res.text).toBe('| a   | b   |\n| --- | --- |\n| 1   | 2   |');
    // cursor should land at the start of "b" on the header line
    expect(res.text[res.cursor]).toBe('b');
  });

  it('Tab at the last cell appends a new row', () => {
    // cursor on "2" (last data cell): offset into the "| 1 | 2 |" line
    const offset = block.indexOf('2');
    const res = navigateTable(block, offset, 'next');
    const lines = res.text.split('\n');
    expect(lines).toHaveLength(4); // header, sep, original row, new row
    expect(lines[3]).toBe('|     |     |'); // new blank row
    expect(res.cursor).toBe(res.text.lastIndexOf('\n') + 3); // start of new row's first cell
  });

  it('Enter moves down the same column, creating a row at the end', () => {
    const res = navigateTable(block, 2, 'down'); // header "a" -> first data row col 0
    expect(res.text.split('\n')).toHaveLength(3);
    expect(res.text[res.cursor]).toBe('1');
  });

  it('returns null for non-table text', () => {
    expect(navigateTable('not a table', 0, 'next')).toBeNull();
  });
});

describe('delimitedToModel', () => {
  it('converts TSV with the first row as header', () => {
    const model = delimitedToModel('a\tb\nc\td');
    expect(model.header).toEqual(['a', 'b']);
    expect(model.rows).toEqual([['c', 'd']]);
  });
  it('converts consistent CSV', () => {
    const model = delimitedToModel('x,y\n1,2\n3,4');
    expect(model.header).toEqual(['x', 'y']);
    expect(model.rows).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
  });
  it('handles quoted CSV fields containing commas', () => {
    const model = delimitedToModel('"a,b",c\n1,2');
    expect(model.header).toEqual(['a,b', 'c']);
    expect(model.rows).toEqual([['1', '2']]);
  });
  it('escapes pipes in converted cells', () => {
    const model = delimitedToModel('a|b\tc\n1\t2');
    expect(model.header).toEqual(['a\\|b', 'c']);
  });
  it('does not convert prose', () => {
    expect(delimitedToModel('hello world\nfoo bar baz')).toBeNull();
    expect(delimitedToModel('just one line')).toBeNull();
  });
});
