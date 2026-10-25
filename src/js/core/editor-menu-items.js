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

/**
 * Menu for a right-click inside the (read-only) preview.
 * @param {{hasSelection: boolean}} state
 * @returns {MenuSpec[]}
 */
export function buildPreviewMenuItems({ hasSelection }) {
  return [{ id: 'copy', label: 'コピー', shortcut: 'Ctrl+C', disabled: !hasSelection }];
}
