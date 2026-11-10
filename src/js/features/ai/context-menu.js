// context-menu.js - Right-click menu for the editor body and the preview.
// Replaces the WebView's default (browser-style) menu with an app menu built
// on the shared core/menu.js, so it looks and behaves like the other menus.
import { EditorView } from '@codemirror/view';
import { language } from '@codemirror/language';
import { undo, redo, undoDepth, redoDepth } from '@codemirror/commands';
import { executeActionDirect } from './composer.js';
import { showMenu } from '../../core/menu.js';
import { sourceTableCell, applySourceTableOp } from '../../core/table-source.js';
import {
  AI_ACTION_IDS,
  buildEditorMenuItems,
  buildPreviewMenuItems,
  TABLE_ITEM_PREFIX,
} from '../../core/editor-menu-items.js';

/**
 * @typedef {Object} ContextMenuCallbacks
 * @property {(selectedText: string) => void} onAskAI - Open chat panel with selected text
 * @property {(view: any) => void} onComposer - Open composer for the view
 * @property {() => any|null} getActiveView - Get the current active EditorView
 * @property {(view: any) => void} [onConvertTable] - Convert the selection to a Markdown table
 * @property {(preview: HTMLElement, target: Element) => ({row: number,
 *   size: {rows: number, cols: number}, run: (op: string) => void} | null)} [previewTableCell]
 *   - The editable table cell a preview right-click is on, if any
 */

/** @type {ContextMenuCallbacks|null} */
let callbacks = null;

/**
 * Initialize the context menu system.
 * @param {ContextMenuCallbacks} cbs
 */
export function initContextMenu(cbs) {
  callbacks = cbs;
  // Capture phase so we run before the WebView's default menu.
  document.getElementById('workspace')?.addEventListener('contextmenu', handleContextMenu, true);
}

/**
 * @param {MouseEvent} e
 */
function handleContextMenu(e) {
  const target = /** @type {Element} */ (e.target);
  const cmEditor = target.closest?.('.cm-editor');
  if (cmEditor) {
    const view =
      EditorView.findFromDOM(/** @type {HTMLElement} */ (cmEditor)) || callbacks?.getActiveView?.();
    if (!view) return;
    e.preventDefault();
    e.stopPropagation();
    moveCursorToClick(view, e.clientX, e.clientY);
    showEditorMenu(view, e.clientX, e.clientY);
    return;
  }
  const preview = target.closest?.('.preview-pane');
  if (preview) {
    e.preventDefault();
    e.stopPropagation();
    showPreviewMenu(preview, target, e.clientX, e.clientY);
  }
}

/**
 * Like most editors: right-clicking outside the current selection moves the
 * cursor there (so Paste lands where you clicked); inside it keeps the selection.
 */
function moveCursorToClick(view, x, y) {
  const pos = view.posAtCoords({ x, y });
  if (pos == null) return;
  const { from, to } = view.state.selection.main;
  if (from !== to && pos >= from && pos <= to) return;
  view.dispatch({ selection: { anchor: pos } });
}

function showEditorMenu(view, x, y) {
  const { from, to, head } = view.state.selection.main;
  // A table at the cursor (Markdown only): offer its rows and columns too.
  const docText = view.state.doc.toString();
  const line = view.state.doc.lineAt(head);
  const tableCell = isMarkdownView(view)
    ? sourceTableCell(docText, line.number - 1, head - line.from)
    : null;
  const specs = buildEditorMenuItems({
    hasSelection: from !== to,
    canUndo: undoDepth(view.state) > 0,
    canRedo: redoDepth(view.state) > 0,
    tableCell,
  });
  const items = specs.map((s) => {
    if (s.separator) return s;
    if (tableCell && s.id.startsWith(TABLE_ITEM_PREFIX)) {
      const op = s.id.slice(TABLE_ITEM_PREFIX.length);
      return { ...s, action: () => runSourceTableOp(view, op) };
    }
    return { ...s, action: () => runEditorAction(s.id, view) };
  });
  showMenu(x, y, items, { onClose: () => view.focus() });
}

/** Markdown editors only: a source file of another language has no tables. */
function isMarkdownView(view) {
  const lang = view.state.facet(language);
  return !lang || /markdown/i.test(lang.name || '');
}

/** Insert / remove a row or column of the table at the cursor, as one undo step. */
function runSourceTableOp(view, op) {
  const { head } = view.state.selection.main;
  const doc = view.state.doc;
  const line = doc.lineAt(head);
  const result = applySourceTableOp(doc.toString(), line.number - 1, head - line.from, op);
  if (!result) return;
  const from = doc.line(result.startLine + 1).from;
  const to = doc.line(result.endLine + 1).to;
  // The cursor's place in the new document: the table starts where it did.
  const newLines = result.text.split('\n');
  let anchor = from;
  for (let i = 0; i < result.cursorLine - result.startLine; i++) anchor += newLines[i].length + 1;
  anchor += result.cursorCol;
  view.dispatch({
    changes: { from, to, insert: result.text },
    selection: { anchor },
    userEvent: 'input.table',
    scrollIntoView: true,
  });
}

function showPreviewMenu(preview, target, x, y) {
  const sel = window.getSelection();
  const text = sel && preview.contains(sel.anchorNode) ? sel.toString() : '';
  const tableCell = callbacks?.previewTableCell?.(preview, target) || null;
  const specs = buildPreviewMenuItems({ hasSelection: text.length > 0, tableCell });
  const items = specs.map((s) => {
    if (s.separator) return s;
    if (tableCell && s.id.startsWith(TABLE_ITEM_PREFIX)) {
      return { ...s, action: () => tableCell.run(s.id.slice(TABLE_ITEM_PREFIX.length)) };
    }
    return { ...s, action: () => s.id === 'copy' && writeClipboard(text) };
  });
  showMenu(x, y, items);
}

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    document.execCommand('copy');
  }
}

function runEditorAction(actionId, view) {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  switch (actionId) {
    case 'undo':
      undo(view);
      break;
    case 'redo':
      redo(view);
      break;
    case 'cut':
      writeClipboard(selected).then(() => {
        view.dispatch({ changes: { from, to, insert: '' } });
      });
      break;
    case 'copy':
      writeClipboard(selected);
      break;
    case 'paste':
      navigator.clipboard
        .readText()
        .then((text) => view.dispatch(view.state.replaceSelection(text)))
        .catch(() => document.execCommand('paste'));
      break;
    case 'delete':
      if (from !== to) view.dispatch({ changes: { from, to, insert: '' } });
      break;
    case 'select-all':
      view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
      break;
    case 'to-table':
      callbacks?.onConvertTable?.(view);
      break;
    case 'ask-ai':
      callbacks?.onAskAI?.(selected);
      break;
    default:
      if (AI_ACTION_IDS.includes(actionId)) executeActionDirect(view, actionId);
      break;
  }
}
