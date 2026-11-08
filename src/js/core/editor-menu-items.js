// editor-menu-items.js - Item specs for the editor / preview right-click menu.
// Pure functions (no DOM, no CodeMirror) so the menu contents can be unit
// tested. Each spec carries an `id`; the caller maps ids to actions.

/**
 * @typedef {Object} MenuSpec
 * @property {string} [id]
 * @property {string} [label]
 * @property {string} [shortcut]
 * @property {boolean} [disabled]
 * @property {boolean} [separator]
 */

const SEP = { separator: true };

/** AI actions that operate on the current selection. */
export const AI_ACTION_IDS = ['rewrite', 'summarize', 'expand', 'fix_grammar'];

/**
 * Menu for a right-click inside the editor body.
 * Selection-dependent edit items stay visible but disabled when nothing is
 * selected (the menu keeps its shape); the AI section only appears with a
 * selection because every AI action needs one.
 *
 * @param {{hasSelection: boolean, canUndo?: boolean, canRedo?: boolean}} state
 * @returns {MenuSpec[]}
 */
export function buildEditorMenuItems({ hasSelection, canUndo = true, canRedo = true }) {
  const noSel = !hasSelection;
  const items = [
    { id: 'undo', label: '元に戻す', shortcut: 'Ctrl+Z', disabled: !canUndo },
    { id: 'redo', label: 'やり直し', shortcut: 'Ctrl+Y', disabled: !canRedo },
    SEP,
    { id: 'cut', label: '切り取り', shortcut: 'Ctrl+X', disabled: noSel },
    { id: 'copy', label: 'コピー', shortcut: 'Ctrl+C', disabled: noSel },
    { id: 'paste', label: '貼り付け', shortcut: 'Ctrl+V' },
    { id: 'delete', label: '削除', shortcut: 'Del', disabled: noSel },
    SEP,
    { id: 'select-all', label: 'すべて選択', shortcut: 'Ctrl+A' },
    SEP,
    { id: 'to-table', label: '選択範囲を表に変換', disabled: noSel },
  ];
  if (hasSelection) {
    items.push(
      SEP,
      { id: 'ask-ai', label: 'AIに質問' },
      { id: 'rewrite', label: 'AIで書き直し' },
      { id: 'summarize', label: 'AIで要約' },
      { id: 'expand', label: 'AIで展開' },
      { id: 'fix_grammar', label: 'AIで文法を修正' },
    );
  }
  return items;
}

/** Prefix of the preview menu's table items; the rest is a table-structure op. */
export const TABLE_ITEM_PREFIX = 'table-';

/**
 * Menu for a right-click inside the preview.
 *
 * On a cell of a table that can be edited, it also offers adding and removing
 * rows and columns there. The items keep their place when they don't apply
 * (no row above the header, the header row can't be removed, nor the only
 * column) and are disabled instead.
 *
 * @param {{hasSelection: boolean,
 *   tableCell?: {row: number, size: {rows: number, cols: number}} | null}} state
 * @returns {MenuSpec[]}
 */
export function buildPreviewMenuItems({ hasSelection, tableCell = null }) {
  const items = [{ id: 'copy', label: 'コピー', shortcut: 'Ctrl+C', disabled: !hasSelection }];
  if (tableCell) {
    const header = tableCell.row === 0;
    const t = TABLE_ITEM_PREFIX;
    items.push(
      SEP,
      {
        id: `${t}row-above`,
        label: '上に行を挿入',
        shortcut: 'Ctrl+Shift+Enter',
        disabled: header,
      },
      { id: `${t}row-below`, label: '下に行を挿入', shortcut: 'Ctrl+Enter' },
      { id: `${t}col-left`, label: '左に列を挿入', shortcut: 'Ctrl+Alt+←' },
      { id: `${t}col-right`, label: '右に列を挿入', shortcut: 'Ctrl+Alt+→' },
      SEP,
      { id: `${t}row-delete`, label: '行を削除', disabled: header },
      { id: `${t}col-delete`, label: '列を削除', disabled: tableCell.size.cols <= 1 },
    );
  }
  return items;
}
