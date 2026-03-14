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

export function setCallbacks({ onChange, onScroll }) {
  onChangeCallback = onChange;
  onScrollCallback = onScroll;
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

  // Create DOM
  const paneId = `pane-${Date.now()}`;
  const el = document.createElement('div');
  el.className = 'pane view-split';
  el.dataset.paneId = paneId;
  el.innerHTML = '<div class="editor-pane"></div><div class="preview-pane"></div>';
  workspace.appendChild(el);

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
    (ratio) => {
      if (onScrollCallback) onScrollCallback(pane, ratio);
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

  // Remove DOM
  pane.element.remove();

  // Remove from list
  const idx = panes.findIndex((p) => p.id === pane.id);
  panes.splice(idx, 1);

  // If only one pane left, remove split class
  const workspace = document.getElementById('workspace');
  if (workspace && panes.length === 1) {
    workspace.classList.remove('split-vertical', 'split-horizontal');
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

// ── Apply theme to all panes ──────────────────────────────

export function applyThemeToAllPanes(theme) {
  for (const pane of panes) {
    if (pane.editorView) {
      setTheme(pane.editorView, theme);
    }
  }
}
