// panes.js - Split pane management (VS Code-like)
// Each pane owns its own EditorView, preview container, file state, etc.

import { createEditor, setTheme, setContent, getContent } from './editor.js';
import { initPreview } from './preview.js';

/**
 * @typedef {Object} Pane
 * @property {string} id
 * @property {HTMLElement} element       - the .pane div
 * @property {HTMLElement} editorContainer
 * @property {HTMLElement} previewContainer
 * @property {import('@codemirror/view').EditorView|null} editorView
 * @property {string|null} filePath
 * @property {string} content
 * @property {boolean} dirty
 */

/** @type {Pane[]} */
let panes = [];
let activePaneId = null;

// Callbacks set by app.js
let onChangeCallback = null;   // (pane, newContent) => void
let onScrollCallback = null;   // (pane, ratio) => void
let onSelectionChangeCallback = null; // (selectedText) => void

export function setCallbacks({ onChange, onScroll, onSelectionChange }) {
  onChangeCallback = onChange;
  onScrollCallback = onScroll;
  onSelectionChangeCallback = onSelectionChange;
}

// ── Initialisation ────────────────────────────────────────

export function initPanes() {
  const el = document.querySelector('.pane[data-pane-id="default"]');
  if (!el) return;

  const pane = makePaneObject('default', el);
  panes = [pane];
  activePaneId = 'default';

  // Click-to-focus for default pane
  el.addEventListener('mousedown', () => {
    setActivePaneById('default');
  });

  updatePaneStyles();
}

function makePaneObject(id, element) {
  return {
    id,
    element,
    editorContainer: element.querySelector('.editor-pane'),
    previewContainer: element.querySelector('.preview-pane'),
    editorView: null,
    filePath: null,
    content: '',
    dirty: false,
  };
}

// ── Getters ───────────────────────────────────────────────

export function getActivePane() {
  return panes.find((p) => p.id === activePaneId) || panes[0] || null;
}

export function getAllPanes() {
  return [...panes];
}

export function getPaneCount() {
  return panes.length;
}

export function getActivePaneEditorContainer() {
  const pane = getActivePane();
  return pane ? pane.editorContainer : null;
}

export function getActivePanePreviewContainer() {
  const pane = getActivePane();
  return pane ? pane.previewContainer : null;
}

// ── Active-pane editor convenience ────────────────────────

/** Return the EditorView of the active pane (or null). */
export function getActivePaneView() {
  const pane = getActivePane();
  return pane ? pane.editorView : null;
}

// ── Splitting ─────────────────────────────────────────────

export function splitVertical() {
  return doSplit('split-vertical');
}

export function splitHorizontal() {
  return doSplit('split-horizontal');
}

function doSplit(cssClass) {
  const workspace = document.getElementById('workspace');
  if (!workspace) return null;

  // Set split direction
  workspace.classList.remove('split-vertical', 'split-horizontal');
  workspace.classList.add(cssClass);

  const source = getActivePane();

  // Create resize handle
  const isVertical = cssClass === 'split-vertical';
  const handle = document.createElement('div');
  handle.className = `pane-resize-handle ${isVertical ? 'vertical' : 'horizontal'}`;
  workspace.appendChild(handle);

  // Create DOM
  const paneId = `pane-${Date.now()}`;
  const el = document.createElement('div');
  el.className = 'pane view-split';
  el.dataset.paneId = paneId;
  el.innerHTML = '<div class="editor-pane"></div><div class="preview-pane"></div>';
  workspace.appendChild(el);

  // Drag resize
  initResizeHandle(handle, workspace, isVertical);

  // Click-to-focus
  el.addEventListener('mousedown', () => {
    setActivePaneById(paneId);
  });

  const pane = makePaneObject(paneId, el);

  // Init preview for the new pane
  initPreview(pane.previewContainer);

  // Copy file from source pane
  if (source && source.editorView) {
    pane.filePath = source.filePath;
    pane.content = source.content;
    pane.dirty = source.dirty;
    createEditorInPane(pane, pane.content);
  }

  panes.push(pane);
  setActivePaneById(paneId);

  return pane;
}

// ── Creating an editor inside a pane ──────────────────────

export function createEditorInPane(pane, content) {
  // Destroy old view if exists
  if (pane.editorView) {
    pane.editorView.destroy();
    pane.editorView = null;
  }

  pane.content = content;

  const view = createEditor(
    pane.editorContainer,
    content,
    (newContent) => {
      pane.content = newContent;
      // Sync same file across other panes
      if (pane.filePath) {
        for (const other of panes) {
          if (other.id !== pane.id && other.filePath === pane.filePath && other.editorView) {
            const otherContent = getContent(other.editorView);
            if (otherContent !== newContent) {
              setContent(other.editorView, newContent);
              other.content = newContent;
            }
          }
        }
      }
      if (onChangeCallback) onChangeCallback(pane, newContent);
    },
    (info) => {
      if (onScrollCallback) onScrollCallback(pane, info);
    },
    (selectedText) => {
      if (onSelectionChangeCallback) onSelectionChangeCallback(selectedText);
    },
  );

  pane.editorView = view;

  // Apply current theme
  const theme = document.documentElement.getAttribute('data-theme') || 'dark';
  setTheme(view, theme);

  return view;
}

// ── Set what file a pane shows ────────────────────────────

export function setActivePaneFile(path, content, editorView) {
  const pane = getActivePane();
  if (!pane) return;
  pane.filePath = path;
  pane.content = content;
  pane.dirty = false;
  if (editorView) pane.editorView = editorView;
}

// ── Closing ───────────────────────────────────────────────

export function closeActivePane() {
  if (panes.length <= 1) return;

  const pane = getActivePane();
  if (!pane) return;

  // Destroy editor
  if (pane.editorView) {
    pane.editorView.destroy();
    pane.editorView = null;
  }

  // Remove DOM and adjacent resize handle
  const prevHandle = pane.element.previousElementSibling;
  if (prevHandle && prevHandle.classList.contains('pane-resize-handle')) {
    prevHandle.remove();
  } else {
    const nextHandle = pane.element.nextElementSibling;
    if (nextHandle && nextHandle.classList.contains('pane-resize-handle')) {
      nextHandle.remove();
    }
  }
  pane.element.remove();

  // Remove from list
  const idx = panes.findIndex((p) => p.id === pane.id);
  panes.splice(idx, 1);

  // If only one pane left, remove split class and reset flex
  const workspace = document.getElementById('workspace');
  if (workspace && panes.length === 1) {
    workspace.classList.remove('split-vertical', 'split-horizontal');
    panes[0].element.style.flex = '';
    // Remove any remaining resize handles
    workspace.querySelectorAll('.pane-resize-handle').forEach((h) => h.remove());
  }

  // Focus remaining pane
  activePaneId = panes[Math.min(idx, panes.length - 1)].id;
  updatePaneStyles();

  // Focus the remaining pane's editor
  const remaining = getActivePane();
  if (remaining && remaining.editorView) {
    remaining.editorView.focus();
  }
}

// ── Focus navigation ──────────────────────────────────────

export function focusPane(direction) {
  if (panes.length <= 1) return;

  const currentIndex = panes.findIndex((p) => p.id === activePaneId);
  if (currentIndex === -1) return;

  let targetIndex;
  if (direction === 'right' || direction === 'down') {
    targetIndex = Math.min(currentIndex + 1, panes.length - 1);
  } else {
    targetIndex = Math.max(currentIndex - 1, 0);
  }

  if (targetIndex !== currentIndex) {
    setActivePaneById(panes[targetIndex].id);
    const target = panes[targetIndex];
    if (target.editorView) {
      setTimeout(() => target.editorView.focus(), 0);
    }
  }
}

// ── Internal ──────────────────────────────────────────────

function setActivePaneById(id) {
  activePaneId = id;
  updatePaneStyles();
}

function updatePaneStyles() {
  const workspace = document.getElementById('workspace');
  if (!workspace) return;

  workspace.querySelectorAll('.pane').forEach((el) => {
    el.classList.toggle('active', el.dataset.paneId === activePaneId);
  });
}

// ── Clear panes showing a closed file ─────────────────────

export function clearPanesWithFile(filePath) {
  for (const pane of panes) {
    if (pane.filePath === filePath) {
      pane.filePath = null;
      pane.content = '';
      pane.dirty = false;
      if (pane.editorView) {
        pane.editorView.destroy();
        pane.editorView = null;
      }
      // Remove split view class so empty state fills the pane
      pane.element.classList.remove('view-split', 'view-preview');
      if (pane.editorContainer) {
        pane.editorContainer.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-title">Fude</div>
            <div class="empty-state-hint"><kbd>Ctrl+O</kbd> Open folder &nbsp; <kbd>Ctrl+N</kbd> New file</div>
          </div>`;
      }
      if (pane.previewContainer) {
        pane.previewContainer.innerHTML = '';
      }
    }
  }
}

// ── Resize handle ────────────────────────────────────────

function initResizeHandle(handle, workspace, isVertical) {
  let startPos = 0;
  let startSizes = [];

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startPos = isVertical ? e.clientX : e.clientY;
    const paneEls = Array.from(workspace.querySelectorAll('.pane'));
    const totalSize = isVertical ? workspace.clientWidth : workspace.clientHeight;
    startSizes = paneEls.map((el) => {
      const rect = el.getBoundingClientRect();
      return isVertical ? rect.width : rect.height;
    });

    const onMouseMove = (ev) => {
      const delta = (isVertical ? ev.clientX : ev.clientY) - startPos;
      const handleIndex = Array.from(workspace.querySelectorAll('.pane-resize-handle')).indexOf(handle);
      const totalSize = isVertical ? workspace.clientWidth : workspace.clientHeight;
      const handleSize = isVertical ? handle.offsetWidth : handle.offsetHeight;
      const available = totalSize - handleSize * (paneEls.length - 1);

      if (handleIndex >= 0 && handleIndex < startSizes.length - 1) {
        const newFirst = Math.max(100, startSizes[handleIndex] + delta);
        const newSecond = Math.max(100, startSizes[handleIndex + 1] - delta);
        const firstPct = (newFirst / available) * 100;
        const secondPct = (newSecond / available) * 100;
        paneEls[handleIndex].style.flex = `0 0 ${firstPct}%`;
        paneEls[handleIndex + 1].style.flex = `0 0 ${secondPct}%`;
      }
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = isVertical ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  });
}

// ── Apply theme to all panes ──────────────────────────────

export function applyThemeToAllPanes(theme) {
  for (const pane of panes) {
    if (pane.editorView) {
      setTheme(pane.editorView, theme);
    }
  }
}
