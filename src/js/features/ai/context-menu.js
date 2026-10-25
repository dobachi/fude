// context-menu.js - Right-click menu for the editor body and the preview.
// Replaces the WebView's default (browser-style) menu with an app menu built
// on the shared core/menu.js, so it looks and behaves like the other menus.
import { EditorView } from '@codemirror/view';
import { undo, redo, undoDepth, redoDepth } from '@codemirror/commands';
import { executeActionDirect } from './composer.js';
import { showMenu } from '../../core/menu.js';
import {
  AI_ACTION_IDS,
  buildEditorMenuItems,
  buildPreviewMenuItems,
} from '../../core/editor-menu-items.js';

/**
 * @typedef {Object} ContextMenuCallbacks
 * @property {(selectedText: string) => void} onAskAI - Open chat panel with selected text
 * @property {(view: any) => void} onComposer - Open composer for the view
 * @property {() => any|null} getActiveView - Get the current active EditorView
 * @property {(view: any) => void} [onConvertTable] - Convert the selection to a Markdown table
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
    showPreviewMenu(preview, e.clientX, e.clientY);
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
  const { from, to } = view.state.selection.main;
  const specs = buildEditorMenuItems({
    hasSelection: from !== to,
    canUndo: undoDepth(view.state) > 0,
    canRedo: redoDepth(view.state) > 0,
  });
  const items = specs.map((s) =>
    s.separator ? s : { ...s, action: () => runEditorAction(s.id, view) },
  );
  showMenu(x, y, items, { onClose: () => view.focus() });
}

function showPreviewMenu(preview, x, y) {
  const sel = window.getSelection();
  const text = sel && preview.contains(sel.anchorNode) ? sel.toString() : '';
  const specs = buildPreviewMenuItems({ hasSelection: text.length > 0 });
  const items = specs.map((s) =>
    s.separator ? s : { ...s, action: () => s.id === 'copy' && writeClipboard(text) },
  );
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
