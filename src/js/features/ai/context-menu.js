// context-menu.js - Custom right-click context menu with AI actions
// Shows AI-related options when text is selected in the editor.

let menuEl = null;

/**
 * @typedef {Object} ContextMenuCallbacks
 * @property {(selectedText: string) => void} onAskAI - Open chat panel with selected text
 * @property {(view: any) => void} onComposer - Open composer for the view
 * @property {() => any|null} getActiveView - Get the current active EditorView
 */

/** @type {ContextMenuCallbacks|null} */
let callbacks = null;

/**
 * Initialize the context menu system.
 * @param {ContextMenuCallbacks} cbs
 */
export function initContextMenu(cbs) {
  callbacks = cbs;

  // Use capture phase to intercept before browser default
  document.getElementById('workspace')?.addEventListener('contextmenu', handleContextMenu, true);

  // Close menu on click outside or Escape
  document.addEventListener('mousedown', (e) => {
    if (menuEl && !menuEl.contains(e.target)) {
      closeMenu();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menuEl) {
      closeMenu();
    }
  });
}

/**
 * @param {MouseEvent} e
 */
function handleContextMenu(e) {
  // Check if the click is inside a CodeMirror editor
  const cmEditor = e.target.closest('.cm-editor');
  if (!cmEditor) return;

  // Get the active EditorView via the callback
  const view = callbacks?.getActiveView?.();
  if (!view) return;

  const { from, to } = view.state.selection.main;
  if (from === to) return; // No selection — let browser default menu show

  e.preventDefault();
  e.stopPropagation();
  showMenu(e.clientX, e.clientY, view);
}

const EDIT_ITEMS = [
  { id: 'cut', label: 'Cut', icon: '✂' },
  { id: 'copy', label: 'Copy', icon: '📋' },
  { id: 'paste', label: 'Paste', icon: '📌' },
  { id: 'delete', label: 'Delete', icon: '🗑' },
  { id: 'select-all', label: 'Select All', icon: '☐' },
];

const AI_ITEMS = [
  { id: 'ask-ai', label: 'Ask AI about this', icon: '💬' },
  { id: 'rewrite', label: 'Rewrite', icon: '✏' },
  { id: 'summarize', label: 'Summarize', icon: '📝' },
  { id: 'expand', label: 'Expand', icon: '📖' },
  { id: 'fix_grammar', label: 'Fix Grammar', icon: '✓' },
];

function showMenu(x, y, view) {
  closeMenu();

  menuEl = document.createElement('div');
  menuEl.className = 'ai-context-menu';

  // Edit items
  for (const item of EDIT_ITEMS) {
    menuEl.appendChild(createMenuItem(item, view));
  }

  // Divider
  const divider = document.createElement('div');
  divider.className = 'ai-context-menu-divider';
  menuEl.appendChild(divider);

  // AI items
  for (const item of AI_ITEMS) {
    menuEl.appendChild(createMenuItem(item, view));
  }

  document.body.appendChild(menuEl);

  // Position within viewport
  const rect = menuEl.getBoundingClientRect();
  if (x + rect.width > window.innerWidth) {
    x = window.innerWidth - rect.width - 8;
  }
  if (y + rect.height > window.innerHeight) {
    y = window.innerHeight - rect.height - 8;
  }
  x = Math.max(8, x);
  y = Math.max(8, y);

  menuEl.style.left = `${x}px`;
  menuEl.style.top = `${y}px`;
}

function createMenuItem(item, view) {
  const btn = document.createElement('button');
  btn.className = 'ai-context-menu-item';
  btn.dataset.action = item.id;
  btn.innerHTML = `<span class="ai-context-menu-icon">${item.icon}</span>${item.label}`;
  btn.addEventListener('click', () => {
    handleAction(item.id, view);
    closeMenu();
  });
  return btn;
}

function handleAction(actionId, view) {
  switch (actionId) {
    case 'cut':
      document.execCommand('cut');
      view.focus();
      break;
    case 'copy':
      document.execCommand('copy');
      view.focus();
      break;
    case 'paste':
      navigator.clipboard.readText().then((text) => {
        view.dispatch(view.state.replaceSelection(text));
        view.focus();
      }).catch(() => {
        document.execCommand('paste');
        view.focus();
      });
      break;
    case 'delete': {
      const { from, to } = view.state.selection.main;
      if (from !== to) {
        view.dispatch({ changes: { from, to, insert: '' } });
      }
      view.focus();
      break;
    }
    case 'select-all':
      view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
      view.focus();
      break;
    case 'ask-ai': {
      if (!callbacks) break;
      const { from, to } = view.state.selection.main;
      const selectedText = view.state.sliceDoc(from, to);
      callbacks.onAskAI(selectedText);
      break;
    }
    default:
      // Composer actions: rewrite, summarize, expand, fix_grammar
      if (callbacks) callbacks.onComposer(view);
      break;
  }
}

function closeMenu() {
  if (menuEl) {
    menuEl.remove();
    menuEl = null;
  }
}
