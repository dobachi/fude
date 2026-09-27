import { describe, it, expect, afterEach, vi } from 'vitest';
import { cellSpans, sanitizeCell, tableCellText, editTableCell } from '../core/table-cell-edit.js';
import { formatTableText, parseTableBlock, splitRow } from '../core/table.js';
import {
  tableCellOf,
  startInlineEdit,
  commitInlineEdit,
  cancelInlineEdit,
  INLINE_EDITOR_CLASS,
} from '../core/preview-edit.js';
import { renderMarkdown, initPreview } from '../core/preview.js';
import { createInlineEditor } from '../core/editor.js';

const cellOf = (line, span) => line.slice(span.from, span.to);

describe('cellSpans', () => {
  it('locates each cell of a piped row', () => {
    const line = '| a | bb |  c  |';
    expect(cellSpans(line).map((s) => cellOf(line, s))).toEqual(['a', 'bb', 'c']);
  });

  it('handles rows without outer pipes', () => {
    const line = 'a | b';
    expect(cellSpans(line).map((s) => cellOf(line, s))).toEqual(['a', 'b']);
  });

  it('agrees with splitRow on escapes and code spans', () => {
    for (const line of ['| a \\| b | c |', '| `x|y` | z |', '|a|b|', '| **q** | `|` |']) {
      expect(cellSpans(line).map((s) => cellOf(line, s))).toEqual(splitRow(line));
    }
  });

  it('gives an empty cell an empty range inside it', () => {
    const line = '| a |   | c |';
    const spans = cellSpans(line);
    expect(spans).toHaveLength(3);
    expect(spans[1].from).toBe(spans[1].to);
    expect(spans[1].from).toBeGreaterThan(spans[1].segFrom);
    expect(spans[1].to).toBeLessThanOrEqual(spans[1].segTo);
  });
});

describe('sanitizeCell', () => {
  it('escapes bare pipes and keeps escaped ones', () => {
    expect(sanitizeCell('a|b')).toBe('a\\|b');
    expect(sanitizeCell('a\\|b')).toBe('a\\|b');
  });

  it('flattens newlines and trims', () => {
    expect(sanitizeCell('  one\ntwo\r\nthree ')).toBe('one two three');
  });

  it('keeps a trailing backslash as is', () => {
    expect(sanitizeCell('a\\')).toBe('a\\');
  });
});

const ragged = ['| h1 | h2 |', '|---|---|', '| a | b |', '| c |'].join('\n');
const loose = ['| h1 | h2 |', '|---|---|', '| a | b |', '| c | d |'].join('\n');

describe('tableCellText', () => {
  it('reads header and body cells as written', () => {
    expect(tableCellText(loose, 0, 1)).toBe('h2');
    expect(tableCellText(loose, 2, 0)).toBe('c');
  });

  it('pads a short row with empty cells', () => {
    expect(tableCellText(ragged, 2, 1)).toBe('');
  });

  it('returns null for cells that do not exist', () => {
    expect(tableCellText(loose, 3, 0)).toBeNull();
    expect(tableCellText(loose, 0, 2)).toBeNull();
    expect(tableCellText(loose, 0, -1)).toBeNull();
    expect(tableCellText('not a table', 0, 0)).toBeNull();
  });
});

describe('editTableCell', () => {
  it('edits only the cell in an unaligned table, leaving other lines untouched', () => {
    const out = editTableCell(loose, 1, 1, 'BEE');
    expect(out).toBe(['| h1 | h2 |', '|---|---|', '| a | BEE |', '| c | d |'].join('\n'));
  });

  it('edits a header cell', () => {
    const out = editTableCell(loose, 0, 0, 'Name');
    expect(out.split('\n')[0]).toBe('| Name | h2 |');
    expect(out.split('\n').slice(1)).toEqual(loose.split('\n').slice(1));
  });

  it('keeps an aligned table aligned after the edit', () => {
    const aligned = formatTableText(parseTableBlock(loose.split('\n')));
    const out = editTableCell(aligned, 1, 0, 'a much longer value');
    expect(out).toBe(formatTableText(parseTableBlock(out.split('\n'))));
    expect(tableCellText(out, 1, 0)).toBe('a much longer value');
    expect(tableCellText(out, 2, 1)).toBe('d');
  });

  it('keeps alignment markers of an aligned table', () => {
    const aligned = formatTableText({
      header: ['l', 'c', 'r'],
      align: ['left', 'center', 'right'],
      rows: [['1', '2', '3']],
    });
    const out = editTableCell(aligned, 1, 1, 'wide cell');
    expect(parseTableBlock(out.split('\n')).align).toEqual(['left', 'center', 'right']);
  });

  it('aligns by display width with CJK text', () => {
    const aligned = formatTableText(parseTableBlock(loose.split('\n')));
    const out = editTableCell(aligned, 1, 1, '日本語');
    expect(out).toBe(formatTableText(parseTableBlock(out.split('\n'))));
  });

  it('fills an empty cell with room around the text', () => {
    const t = ['| h1 | h2 |', '|---|---|', '| a ||'].join('\n');
    const out = editTableCell(t, 1, 1, 'x');
    expect(splitRow(out.split('\n')[2])).toEqual(['a', 'x']);
  });

  it('clearing a cell leaves an empty cell', () => {
    const out = editTableCell(loose, 1, 1, '');
    expect(tableCellText(out, 1, 1)).toBe('');
    expect(tableCellText(out, 1, 0)).toBe('a');
  });

  it('escapes pipes so the edit cannot split the cell', () => {
    const out = editTableCell(loose, 1, 0, 'x|y');
    expect(splitRow(out.split('\n')[2])).toEqual(['x\\|y', 'b']);
  });

  it('writes a cell missing from a short row by rebuilding the table', () => {
    const out = editTableCell(ragged, 2, 1, 'new');
    expect(tableCellText(out, 2, 1)).toBe('new');
    expect(tableCellText(out, 1, 1)).toBe('b');
  });

  it('returns null for cells outside the table', () => {
    expect(editTableCell(loose, 3, 0, 'x')).toBeNull();
    expect(editTableCell(loose, 0, 5, 'x')).toBeNull();
    expect(editTableCell(loose, -1, 0, 'x')).toBeNull();
    expect(editTableCell('para', 0, 0, 'x')).toBeNull();
  });
});

describe('tableCellOf', () => {
  function tableFrom(src) {
    const c = document.createElement('div');
    renderMarkdown(src, '', c);
    return c;
  }

  it('maps header and body cells to (row, col)', () => {
    const c = tableFrom('| a | b |\n|---|---|\n| c | d |\n| e | f |\n');
    const table = c.querySelector('table');
    const cells = table.querySelectorAll('th, td');
    expect(tableCellOf(table, cells[1])).toMatchObject({ row: 0, col: 1 });
    expect(tableCellOf(table, cells[2])).toMatchObject({ row: 1, col: 0 });
    expect(tableCellOf(table, cells[5])).toMatchObject({ row: 2, col: 1, cellEl: cells[5] });
  });

  it('resolves from an inline element inside the cell', () => {
    const c = tableFrom('| **a** | b |\n|---|---|\n');
    const table = c.querySelector('table');
    expect(tableCellOf(table, c.querySelector('strong'))).toMatchObject({ row: 0, col: 0 });
  });

  it('is null outside a table block or outside cells', () => {
    const c = tableFrom('para\n\n| a |\n|---|\n');
    expect(tableCellOf(c.querySelector('p'), c.querySelector('p'))).toBeNull();
    const table = c.querySelector('table');
    expect(tableCellOf(table, table)).toBeNull();
    expect(tableCellOf(table, null)).toBeNull();
  });
});

describe('in-cell inline editing', () => {
  let container;

  afterEach(() => {
    cancelInlineEdit();
    if (container) container.remove();
  });

  function fakeMount(host, text, handlers) {
    const ta = document.createElement('textarea');
    ta.value = text;
    host.appendChild(ta);
    fakeMount.last = { ta, handlers };
    return { state: { doc: { toString: () => ta.value } }, destroy: () => ta.remove() };
  }

  it('the double-click request carries the cell', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    const onBlockEdit = vi.fn();
    initPreview(container, { onBlockEdit });
    renderMarkdown('| a | b |\n|---|---|\n| c | d |\n', '', container);
    container
      .querySelectorAll('td')[1]
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const req = onBlockEdit.mock.calls[0][0];
    expect(req.line).toBe(1);
    expect(req.cell).toMatchObject({ row: 1, col: 1 });
  });

  it('a paragraph double-click carries no cell', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    const onBlockEdit = vi.fn();
    initPreview(container, { onBlockEdit });
    renderMarkdown('para\n', '', container);
    container.querySelector('p').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(onBlockEdit.mock.calls[0][0].cell).toBeNull();
  });

  it('edits inside the cell and restores its content, leaving the table in place', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    renderMarkdown('| a | **b** |\n|---|---|\n', '', container);
    const table = container.querySelector('table');
    const th = table.querySelectorAll('th')[1];
    const before = th.innerHTML;
    const onCommit = vi.fn();
    startInlineEdit({
      container,
      blockEl: table,
      cellEl: th,
      text: '**b**',
      mountEditor: fakeMount,
      onCommit,
    });
    expect(table.isConnected).toBe(true);
    expect(th.querySelector(`.${INLINE_EDITOR_CLASS}`)).not.toBeNull();
    expect(th.querySelector('strong')).toBeNull();

    fakeMount.last.ta.value = 'B';
    commitInlineEdit();
    expect(onCommit).toHaveBeenCalledWith('B');
    expect(th.innerHTML).toBe(before);
  });
});

describe('createInlineEditor singleLine', () => {
  it('Enter finishes the edit instead of inserting a line', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const commit = vi.fn();
    const view = createInlineEditor(parent, 'cell', { commit }, 4, { singleLine: true });
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    expect(commit).toHaveBeenCalledTimes(1);
    expect(view.state.doc.toString()).toBe('cell');
    view.destroy();
    parent.remove();
  });

  it('without singleLine, Enter does not finish the edit', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const commit = vi.fn();
    const view = createInlineEditor(parent, 'para', { commit }, 4);
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    expect(commit).not.toHaveBeenCalled();
    view.destroy();
    parent.remove();
  });
});
