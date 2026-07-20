// app.js - Main orchestrator
import * as backend from './backend.js';
import {
  getContent,
  getCursor,
  getScroll,
  setCursor,
  setScroll,
  setFontSize,
  getFontSize,
  setContent,
  setContentFromDisk,
  scrollEditorToLine,
  jumpToLine,
  flashLine,
  registerPanesModule,
  registerImagePasteHandler,
  registerSaveHandler,
  toggleBold,
  toggleBullet,
  toggleNumbered,
  openSearch,
  setSourceCodeMode,
} from './core/editor.js';
import { shouldOpenAsCode } from './core/file-lang.js';
import {
  initOutline,
  updateOutline,
  setActiveOutlineLine,
  clearOutline,
  focusOutline,
} from './core/outline.js';
import { isImagePath, mimeToExt, insertImageMarkdown } from './core/image-insert.js';
import { attachPanZoom } from './core/svg-panzoom.js';
import { convertFileSrc } from '@tauri-apps/api/core';
import { showToast } from './core/toast.js';
import { showMenu } from './core/menu.js';
import { showTableGridPicker } from './core/table-grid.js';
import {
  initMenuBar,
  toggleMenuBar,
  focusMenuBar,
  openMenuByAccessKey,
  moveOpenMenu,
  isMenuOpen,
} from './core/menubar.js';
import { createAltTap } from './core/menu-nav.js';
import { emptyTableModel, formatTableText } from './core/table.js';
import { promptDialog, confirmDialog } from './core/dialog.js';
import {
  initPreview,
  syncPreviewToLine,
  getLineFromPreview,
  setPlantumlEnabled,
  setMermaidEnabled,
  setCodeHighlightEnabled,
  renderPreview,
  scrollToAnchor,
} from './core/preview.js';
import {
  openTab,
  closeTab,
  duplicateTab,
  nextTab,
  prevTab,
  getActiveTab,
  markDirty,
  markClean,
  updateTabContent,
  updateTabCursor,
  updateTabScroll,
  updateTabPath,
  setTabChangeCallback,
  setTabPathChangeCallback,
  setTabContextMenuCallback,
  closeOtherTabs,
  closeTabsToRight,
  closeAllTabs,
  getTabsForSession,
  getActiveTabIndex,
  getAllTabs,
  setTabViewMode,
  getTabViewMode,
  setTabDiskHash,
  getTabDiskHash,
  getTabByPath,
} from './core/tabs.js';
import { sha256Hex } from './core/hash.js';
import { shouldWarnConflict, showConflictDialog } from './core/save-conflict.js';
import { tabActionForKey } from './core/tab-keys.js';
import { setUiFontSize, getUiFontSize } from './core/ui-font.js';
import * as panesModule from './core/panes.js';
const {
  initPanes,
  splitVertical,
  splitHorizontal,
  closeActivePane,
  focusPane,
  getActivePane,
  getActivePaneView,
  getPaneByPreviewContainer,
  focusEditorView,
  setCallbacks,
  createEditorInPane,
  getPaneCount,
} = panesModule;
import {
  initSidebar,
  loadDirectory,
  toggleSidebar,
  highlightFile,
  getShowAllFiles,
  isSidebarVisible,
  showSidebar,
  focusFiler,
  nextSidebarFocusAction,
} from './core/sidebar.js';
import { scheduleSave, restoreSession } from './core/session.js';
import { initTheme } from './core/theme.js';
import { onContentChange, triggerSave, checkRecovery } from './core/autosave.js';
import {
  initFileWatcher,
  initDirectoryWatcher,
  watchVault,
  watchFile,
  unwatchFile,
  reloadFromDisk,
  showReloadBanner,
  dismissReloadBanner,
} from './core/file-watcher.js';
import { initKeymode, reapplyMode, cycleMode, setAppVersion, getMode } from './core/keymode.js';
import { openSettings } from './settings.js';
import { openFolderPicker } from './folder-picker.js';
import { openSavePicker } from './file-save-picker.js';
import { isOpenFileShortcut, isGoToPathShortcut, isPrintShortcut } from './core/open-shortcuts.js';
import { normalizeInputPath } from './core/pathnorm.js';

import { isLocalTauri } from './backend.js';
import { openHelp } from './help.js';
import { checkForUpdates } from './core/updater.js';
import {
  initAICopilot,
  openComposerForView,
  initChatPanel,
  toggleAIPanel,
  updateSelectedContext,
  updateDocContext,
  isAIPanelOpen,
  focusAIPanelInput,
} from './features/ai-copilot.js';
import { initContextMenu } from './features/ai/context-menu.js';

// Default view mode for newly opened tabs and the fallback when no tab is
// active. Per-tab view modes live on each tab (see tabs.js setTabViewMode).
// Seeded from the restored session for backward compatibility.
let defaultViewMode = 'split';

// Source code mode: when on, non-Markdown files open with their own language as
// editor-only. Mirrors editor.js's flag so app-level open logic can branch.
let sourceCodeModeEnabled = false;

/** View mode of the currently active tab (falls back to the default). */
function currentViewMode() {
  const tab = getActiveTab();
  return tab ? getTabViewMode(tab.id) : defaultViewMode;
}

/** View mode of the tab a given pane is displaying (falls back to the default). */
function paneViewMode(pane) {
  const tab =
    pane && pane.filePath ? getAllTabs().find((t) => t.path === pane.filePath) : getActiveTab();
  return tab ? getTabViewMode(tab.id) : defaultViewMode;
}

// True for the primary "main" window. Only the main window restores and
// persists the global session; additional windows (label "win-*") open empty
// or with a file handed to them, and never overwrite session.json.
let isMainWindow = true;

let vaultPath = '';
let config = {};

// Register panes module with editor.js so getCurrentView() works without circular imports
registerPanesModule(panesModule);

/** Helper: get the active pane's EditorView */
function currentView() {
  return getActivePaneView();
}

/** Move keyboard focus back to the active pane's editor (robustly). */
function focusActiveEditor() {
  focusEditorView(getActivePaneView());
}

/**
 * Ctrl+Shift+E focus-cycle across the sidebar: hidden → filer → outline →
 * filer (loops, never hides). Esc is the way back to the editor. The decision
 * is computed by the pure nextSidebarFocusAction(); here we execute it.
 */
function cycleSidebarFocus() {
  const active = document.activeElement;
  const fileTree = document.getElementById('file-tree');
  const action = nextSidebarFocusAction({
    visible: isSidebarVisible(),
    focusInFiler: !!(fileTree && fileTree.contains(active)),
  });
  switch (action) {
    case 'show-filer':
      showSidebar();
      focusFiler();
      break;
    case 'focus-outline':
      focusOutline();
      break;
    case 'focus-filer':
    default:
      focusFiler();
      break;
  }
}

/** Re-render the preview in every pane (used after a live config change). */
function rerenderPreviews() {
  for (const p of panesModule.getAllPanes()) {
    if (!p.previewContainer) continue;
    const mode = paneViewMode(p);
    if (mode !== 'split' && mode !== 'preview') continue;
    const basePath = dirnameOf(p.filePath);
    renderPreview(p.content || '', basePath, p.previewContainer, p.filePath);
  }
}

/**
 * Return the parent directory of an OS path. Handles both POSIX (/) and
 * Windows (\) separators so basePath derivation works on every platform.
 * Returns '' if path is falsy or has no separator.
 */
function dirnameOf(path) {
  if (!path) return '';
  const lastSep = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return lastSep >= 0 ? path.substring(0, lastSep) : '';
}

const SIDEBAR_SPLIT_KEY = 'fude.sidebarSplit';
const SIDEBAR_WIDTH_KEY = 'fude.sidebarWidth';
const EDITOR_PREVIEW_RATIO_KEY = 'fude.editorPreviewRatio';

/**
 * Set up the drag handle between #file-tree and #outline-section. The split
 * is stored as a pixel height for #file-tree (driving --filetree-height)
 * and persisted to localStorage, with a sensible default of 50% on first use.
 */
function initSidebarResizer() {
  const resizer = document.getElementById('sidebar-resizer');
  const sidebar = document.getElementById('sidebar');
  const fileTree = document.getElementById('file-tree');
  if (!resizer || !sidebar || !fileTree) return;

  // Apply persisted size (if any) before any drag. Stored as integer pixels.
  try {
    const saved = parseInt(localStorage.getItem(SIDEBAR_SPLIT_KEY) || '', 10);
    if (Number.isFinite(saved) && saved > 0) {
      document.documentElement.style.setProperty('--filetree-height', `${saved}px`);
    }
  } catch {
    /* localStorage unavailable (private mode etc.) — keep CSS default */
  }

  const MIN_TREE_PX = 60;
  const MIN_OUTLINE_PX = 80;

  resizer.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = fileTree.getBoundingClientRect().height;
    const sidebarHeight = sidebar.getBoundingClientRect().height;
    const resizerHeight = resizer.getBoundingClientRect().height;
    const maxTree = sidebarHeight - resizerHeight - MIN_OUTLINE_PX - getSidebarHeaderHeight();
    resizer.classList.add('resizing');
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    const onMove = (mv) => {
      const next = Math.max(
        MIN_TREE_PX,
        Math.min(Math.max(MIN_TREE_PX, maxTree), startHeight + (mv.clientY - startY)),
      );
      document.documentElement.style.setProperty('--filetree-height', `${next}px`);
    };
    const onUp = () => {
      resizer.classList.remove('resizing');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      try {
        const final = Math.round(fileTree.getBoundingClientRect().height);
        localStorage.setItem(SIDEBAR_SPLIT_KEY, String(final));
      } catch {
        /* ignore */
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // Double-click resets to the 50/50 default.
  resizer.addEventListener('dblclick', () => {
    document.documentElement.style.removeProperty('--filetree-height');
    try {
      localStorage.removeItem(SIDEBAR_SPLIT_KEY);
    } catch {
      /* ignore */
    }
  });
}

function getSidebarHeaderHeight() {
  const header = document.getElementById('sidebar-header');
  return header ? header.getBoundingClientRect().height : 0;
}

/**
 * Apply the persisted editor/preview ratio (0..1) to all panes via a global
 * CSS variable. A single value is shared across panes by design; per-pane
 * splits drift the user's mental model and add little for a markdown editor.
 */
function applySavedEditorPreviewRatio() {
  try {
    const raw = localStorage.getItem(EDITOR_PREVIEW_RATIO_KEY);
    const ratio = parseFloat(raw);
    if (Number.isFinite(ratio) && ratio > 0 && ratio < 1) {
      document.documentElement.style.setProperty(
        '--editor-pane-width',
        `${(ratio * 100).toFixed(2)}%`,
      );
    }
  } catch {
    /* localStorage unavailable — keep CSS default */
  }
}

/**
 * Copy dropped image files into the active document's `assets/` folder and
 * insert Markdown references at the cursor. Requires the active tab to be saved
 * (so we know where `assets/` should live).
 */
async function insertImageFiles(imagePaths, view) {
  const tab = getActiveTab();
  if (!tab || !tab.path) {
    showToast('画像を挿入するには、先にファイルを保存してください', { type: 'error' });
    return;
  }
  for (const imgPath of imagePaths) {
    try {
      const relPath = await backend.copyImageToAssets(imgPath, tab.path);
      insertImageMarkdown(view, relPath);
    } catch (e) {
      console.error('Failed to insert image:', e);
      showToast(`画像の挿入に失敗しました: ${e?.message || e}`, { type: 'error', duration: 8000 });
    }
  }
}

/**
 * Drag the vertical bar between editor and preview inside any pane via
 * event delegation. Drag updates --editor-pane-width as pixels for smooth
 * motion; on release we convert to a percent ratio and persist it.
 * Double-click on the resizer resets to the 50/50 default.
 */
function initEditorPreviewResizer() {
  applySavedEditorPreviewRatio();

  document.addEventListener('mousedown', (e) => {
    const resizer = e.target.closest && e.target.closest('.editor-preview-resizer');
    if (!resizer) return;
    const pane = resizer.closest('.pane');
    if (!pane || !pane.classList.contains('view-split')) return;
    if (e.button !== 0) return;

    const editorEl = pane.querySelector('.editor-pane');
    const previewEl = pane.querySelector('.preview-pane');
    if (!editorEl || !previewEl) return;

    e.preventDefault();
    const startX = e.clientX;
    const startEditorWidth = editorEl.getBoundingClientRect().width;
    const paneRect = pane.getBoundingClientRect();
    const resizerWidth = resizer.getBoundingClientRect().width;
    const MIN_SIDE_PX = 100;
    const maxEditorWidth = paneRect.width - resizerWidth - MIN_SIDE_PX;

    resizer.classList.add('resizing');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (mv) => {
      const next = Math.max(
        MIN_SIDE_PX,
        Math.min(maxEditorWidth, startEditorWidth + (mv.clientX - startX)),
      );
      // Pixels during drag for snappy feedback; we convert to % on release.
      document.documentElement.style.setProperty('--editor-pane-width', `${next}px`);
    };
    const onUp = () => {
      resizer.classList.remove('resizing');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);

      // Save as a ratio so the split survives window/pane resizes.
      const finalEditor = editorEl.getBoundingClientRect().width;
      const paneWidth = pane.getBoundingClientRect().width;
      if (paneWidth > 0) {
        const ratio = finalEditor / paneWidth;
        document.documentElement.style.setProperty(
          '--editor-pane-width',
          `${(ratio * 100).toFixed(2)}%`,
        );
        try {
          localStorage.setItem(EDITOR_PREVIEW_RATIO_KEY, String(ratio));
        } catch {
          /* ignore */
        }
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // Double-click on the resizer resets to the default 50/50.
  document.addEventListener('dblclick', (e) => {
    const resizer = e.target.closest && e.target.closest('.editor-preview-resizer');
    if (!resizer) return;
    document.documentElement.style.removeProperty('--editor-pane-width');
    try {
      localStorage.removeItem(EDITOR_PREVIEW_RATIO_KEY);
    } catch {
      /* ignore */
    }
  });
}

/**
 * Set up the drag handle on the right edge of #sidebar. The width drives
 * --sidebar-width (consumed by the #app grid template) and is persisted to
 * localStorage. Double-click resets to the CSS default.
 */
function initSidebarWidthResizer() {
  const resizer = document.getElementById('sidebar-width-resizer');
  const sidebar = document.getElementById('sidebar');
  if (!resizer || !sidebar) return;

  // Apply persisted width before any drag.
  try {
    const saved = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY) || '', 10);
    if (Number.isFinite(saved) && saved > 0) {
      document.documentElement.style.setProperty('--sidebar-width', `${saved}px`);
    }
  } catch {
    /* localStorage unavailable — keep CSS default */
  }

  const MIN_WIDTH = 140;
  const MAX_WIDTH_RATIO = 0.6; // never let the sidebar exceed 60% of the viewport

  resizer.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebar.getBoundingClientRect().width;
    const maxWidth = Math.max(MIN_WIDTH, window.innerWidth * MAX_WIDTH_RATIO);
    resizer.classList.add('resizing');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (mv) => {
      const next = Math.max(MIN_WIDTH, Math.min(maxWidth, startWidth + (mv.clientX - startX)));
      document.documentElement.style.setProperty('--sidebar-width', `${next}px`);
    };
    const onUp = () => {
      resizer.classList.remove('resizing');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      try {
        const final = Math.round(sidebar.getBoundingClientRect().width);
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(final));
      } catch {
        /* ignore */
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // Double-click to reset to the CSS default.
  resizer.addEventListener('dblclick', () => {
    document.documentElement.style.removeProperty('--sidebar-width');
    try {
      localStorage.removeItem(SIDEBAR_WIDTH_KEY);
    } catch {
      /* ignore */
    }
  });
}

/**
 * Handle an image paste: save the clipboard image bytes into the active
 * document's `assets/` folder and insert a Markdown reference. Registered with
 * editor.js, which fires this when a paste contains image data.
 */
async function handleImagePaste(view, images) {
  const tab = getActiveTab();
  if (!tab || !tab.path) {
    showToast('画像を貼り付けるには、先にファイルを保存してください', { type: 'error' });
    return;
  }
  for (const { file, type } of images) {
    try {
      const buf = await file.arrayBuffer();
      const bytes = Array.from(new Uint8Array(buf));
      const relPath = await backend.saveImageBytes(bytes, tab.path, mimeToExt(type));
      insertImageMarkdown(view, relPath);
    } catch (e) {
      console.error('Failed to paste image:', e);
      showToast(`画像の貼り付けに失敗しました: ${e?.message || e}`, {
        type: 'error',
        duration: 8000,
      });
    }
  }
}

// Wire the image-paste handler into the editor (Tauri only — relies on the
// native fs commands to write into assets/).
if (isLocalTauri()) {
  registerImagePasteHandler(handleImagePaste);
}

// Let Emacs mode's native C-x C-s save the file.
registerSaveHandler(() => performSave({ forceDialog: false }));

// ── Initialization ─────────────────────────────────────────
async function init() {
  try {
    config = await backend.getConfig();
  } catch {
    config = {
      theme: 'dark',
      features: { ai_copilot: false, diff_highlight: true },
      font_size: 14,
      ui_font_size: 14,
      key_mode: 'normal',
    };
  }

  initTheme(config.theme || 'dark');
  setPlantumlEnabled(config.features?.plantuml_preview);
  setMermaidEnabled(config.features?.mermaid_preview);
  setCodeHighlightEnabled(config.features?.code_highlight);
  sourceCodeModeEnabled = !!config.features?.source_code_mode;
  setSourceCodeMode(sourceCodeModeEnabled);

  // Live-apply config changes saved from the Settings panel.
  window.addEventListener('fude:config-saved', (e) => {
    const saved = e.detail || {};
    config = saved;
    setPlantumlEnabled(saved.features?.plantuml_preview);
    setMermaidEnabled(saved.features?.mermaid_preview);
    setCodeHighlightEnabled(saved.features?.code_highlight);
    sourceCodeModeEnabled = !!saved.features?.source_code_mode;
    setSourceCodeMode(sourceCodeModeEnabled);
    if (saved.ui_font_size) setUiFontSize(saved.ui_font_size);
    rerenderPreviews();
  });

  // Stamp app version into title and mode badge ASAP so it's visible even if
  // a later init step throws. Tauri-only; browser mode just shows mode without version.
  if (isLocalTauri()) {
    try {
      const { getVersion } = await import('@tauri-apps/api/app');
      const ver = await getVersion();
      setAppVersion(ver);
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const appWindow = getCurrentWindow();
      isMainWindow = appWindow.label === 'main';
      await appWindow.setTitle(`Fude v${ver}`);
    } catch (e) {
      console.warn('Could not read/set app version:', e);
      setAppVersion('?');
    }
  }

  // Restore the keymode (normal / vim / emacs). Backward compat: legacy `vim_mode: true`.
  await initKeymode(config.key_mode || (config.vim_mode ? 'vim' : 'normal'));
  if (config.font_size) setFontSize(config.font_size);
  if (config.ui_font_size) setUiFontSize(config.ui_font_size);

  // Init preview for the default pane
  const previewEl = document.querySelector('.pane[data-pane-id="default"] .preview-pane');
  if (previewEl)
    initPreview(previewEl, {
      onSourceJump: handlePreviewSourceJump,
      onFileLink: handlePreviewFileLink,
    });

  initPanes();

  // Wire up pane callbacks for editor changes, scroll sync, and selection changes
  setCallbacks({
    onChange: handlePaneContentChange,
    onScroll: handlePaneScroll,
    onPreviewScroll: handlePreviewScroll,
    onSelectionChange: handleSelectionChange,
    onSourceJump: handlePreviewSourceJump,
    onFileLink: handlePreviewFileLink,
    onEditorCreated: () => {
      reapplyMode();
    },
  });

  // Init sidebar
  const fileTree = document.getElementById('file-tree');
  if (fileTree)
    initSidebar(fileTree, handleFileSelect, {
      sort: config.sidebar_sort || 'name_asc',
      showAllFiles: config.sidebar_show_all_files || false,
      onSettingsChange: handleSidebarSettingsChange,
      onContextMenu: handleFileContextMenu,
    });

  // Init outline (document headings) below the file tree.
  const outlineList = document.getElementById('outline-list');
  if (outlineList) {
    initOutline(outlineList, {
      onJump: (line) => {
        // Jumping is a user-initiated move; skip the editor→preview lockout
        // that typing installs, but suppress the bounce-back from the editor
        // scroll event we are about to dispatch.
        recordScrollSync('editor');
        const view = currentView();
        if (view) jumpToLine(view, line);
        // In preview-only mode the editor is hidden and the editor→preview
        // scroll sync only runs in split mode, so scroll the preview directly.
        if (currentViewMode() === 'preview') {
          const pane = getActivePane();
          if (pane && pane.previewContainer) syncPreviewToLine(pane.previewContainer, line);
        }
      },
    });
  }

  // Sidebar resizer: drag to redistribute height between file-tree and
  // outline-section. Persist the split to localStorage so it survives
  // restart.
  initSidebarResizer();

  // Sidebar width resizer: drag the right edge of the sidebar to change
  // its horizontal width. Also persisted.
  initSidebarWidthResizer();

  // Editor↔Preview resizer: drag the thin bar between the editor and the
  // preview inside any pane. Uses event delegation so dynamically created
  // panes work without extra wiring.
  initEditorPreviewResizer();

  // Tab change callback
  setTabChangeCallback(handleTabChange);
  setTabPathChangeCallback(handleTabPathChange);
  setTabContextMenuCallback(handleTabContextMenu);
  initFileWatcher(handleExternalFileChange);
  // Refresh the sidebar tree when files change anywhere under the open vault.
  initDirectoryWatcher(refreshTree);

  // Global keyboard shortcuts - capture at window level to override browser defaults
  window.addEventListener('keydown', handleGlobalKeys, true);

  // Alt の単押し検出。keydown は上の capture 側とは別に素通しで見て、
  // Alt を押している間に他のキーが来たら単押しではないと判断する。
  window.addEventListener('keydown', (e) => altTap.keydown(e), true);
  window.addEventListener('keyup', (e) => altTap.keyup(e), true);
  // フォーカスが外れた間の押下は無効（Alt+Tab でウィンドウを切り替えたときに
  // 戻ってきてメニューが開くのを防ぐ）
  window.addEventListener('blur', () => altTap.reset());

  // TODO: Vim ESC/Ctrl+[ handling for browser mode - pending research

  // When editor loses focus, re-focus it
  document.addEventListener('focusout', (e) => {
    // Only re-focus if nothing else meaningful got focus
    setTimeout(() => {
      const active = document.activeElement;
      if (!active || active === document.body || active.tagName === 'HTML') {
        // AIパネル内をクリック/選択中ならエディタに戻さない
        const aiPanel = document.getElementById('ai-panel');
        if (aiPanel && (aiPanel.contains(active) || aiPanel.matches(':hover'))) return;
        const view = currentView();
        if (view) view.focus();
      }
    }, 10);
  });

  // Ctrl+mouse wheel zoom (debounced to prevent freezing)
  let zoomTimeout = null;
  window.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        if (zoomTimeout) return;
        zoomTimeout = setTimeout(() => {
          zoomTimeout = null;
        }, 50);
        if (e.deltaY < 0) {
          setFontSize(Math.min(32, getFontSize() + 1));
        } else {
          setFontSize(Math.max(10, getFontSize() - 1));
        }
      }
    },
    { passive: false },
  );

  // Sidebar toggle buttons
  const sidebarToggle = document.getElementById('sidebar-toggle');
  if (sidebarToggle) sidebarToggle.addEventListener('click', toggleSidebar);
  const sidebarOpen = document.getElementById('sidebar-open');
  if (sidebarOpen) sidebarOpen.addEventListener('click', toggleSidebar);

  // タブバー右端の表示切替（マウス操作用）。キーボードの
  // Ctrl+Shift+J/K/L と同じ setViewMode を呼ぶだけで、状態は一箇所に保つ。
  document.querySelectorAll('.view-mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => setViewMode(btn.dataset.mode));
  });

  // Menu bar (hidden by default; toggled with Ctrl+Shift+B).
  const menuBarEl = document.getElementById('menu-bar');
  if (menuBarEl) initMenuBar(menuBarEl, buildMenuDefinition());

  // Additional windows are handed a file to open via take_open_request; the
  // main window relies on the cli-args event instead (so this stays null there).
  let pendingOpen = null;
  if (isLocalTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      pendingOpen = await invoke('take_open_request');
    } catch {
      /* ignore */
    }
  }

  // Try restore session — only the main window restores the global session.
  const session = isMainWindow ? await restoreSession() : null;
  if (session && session.open_tabs && session.open_tabs.length > 0) {
    vaultPath = session.vault_path || '';
    defaultViewMode = session.view_mode || 'split';
    applyViewMode();

    if (vaultPath) {
      try {
        const tree = await backend.readDirTree(vaultPath, getShowAllFiles());
        loadDirectory(tree);
        watchVault(vaultPath);
      } catch {
        /* ignore */
      }
    }

    // Check for crash recovery temp files
    const tabPaths = session.open_tabs.map((t) => t.path).filter(Boolean);
    const recoverable = await checkRecovery(tabPaths);
    const recoverableMap = {};
    for (const info of recoverable) {
      recoverableMap[info.original_path] = info.temp_path;
    }
    const recoverablePaths = Object.keys(recoverableMap);

    // First, open all tabs with saved content
    for (const tabInfo of session.open_tabs) {
      try {
        const viewMode = tabInfo.view_mode || defaultViewMode;
        if (isImagePath(tabInfo.path)) {
          openTab(tabInfo.path, '', { kind: 'image', viewMode });
          continue;
        }
        const content = await backend.readFile(tabInfo.path);
        const restored = openTab(tabInfo.path, content, { viewMode });
        if (restored) await markTabSynced(restored.id, content);
      } catch {
        /* ignore */
      }
    }

    // Then ask about recovery if temp files exist
    if (recoverablePaths.length > 0) {
      const names = recoverablePaths.map((p) => p.split('/').pop()).join(', ');
      showRecoveryDialog(
        names,
        async () => {
          // Recover: replace tab content with temp file content
          for (const path of recoverablePaths) {
            try {
              const tempContent = await backend.readFile(recoverableMap[path]);
              const tab = getAllTabs().find((t) => t.path === path);
              if (tab) {
                updateTabContent(tab.id, tempContent);
                markDirty(tab.id);
                // If this is the active tab, reload the editor
                const active = getActiveTab();
                if (active && active.id === tab.id) {
                  const view = currentView();
                  if (view) {
                    setContent(view, tempContent);
                  }
                }
              }
            } catch {
              /* ignore */
            }
          }
        },
        async () => {
          // Decline: delete temp files
          for (const path of recoverablePaths) {
            try {
              await backend.deleteTempFile(path);
            } catch {
              /* ignore */
            }
          }
        },
      );
    }

    // A CLI launch path arrives alongside a restored session: open it as an
    // additional tab on top, matching the pre-queue (`cli-args` event) behavior.
    if (pendingOpen && pendingOpen.path) {
      await openPath(pendingOpen.path);
    }
  } else if (pendingOpen && pendingOpen.path) {
    // A new window opened with a specific file (e.g. "open in new window").
    await openPath(pendingOpen.path);
  } else {
    // Check if server specified an initial directory
    if (!isLocalTauri()) {
      try {
        const openDir = await backend.getOpenDir();
        if (openDir) {
          vaultPath = openDir;
          const tree = await backend.readDirTree(openDir, getShowAllFiles());
          loadDirectory(tree);
          watchVault(vaultPath);
        }
      } catch {
        /* ignore */
      }
    }
    openTab(
      null,
      '# Welcome to Fude\n\nOpen a file with **Ctrl+O**, a folder with **Ctrl+Shift+O**, or start a new tab with **Ctrl+Shift+T**.\n',
    );
    applyViewMode();
  }

  // Listen for CLI args and drag-drop events from Tauri
  if (isLocalTauri()) {
    const { listen } = await import('@tauri-apps/api/event');
    listen('cli-args', async (event) => {
      const path = event.payload?.path;
      if (path) await openPath(path);
    });

    // Handle files dropped from the file manager: images are inserted into the
    // active editor, everything else opens as a tab (previous behavior).
    listen('tauri://drag-drop', async (event) => {
      const paths = event.payload?.paths;
      if (!paths || paths.length === 0) return;

      const view = currentView();
      const images = view ? paths.filter(isImagePath) : [];
      const others = view ? paths.filter((p) => !isImagePath(p)) : paths;

      if (images.length > 0) {
        // Move the cursor to the drop location when we can map it; otherwise
        // fall back to inserting at the current cursor position.
        const pos = event.payload?.position;
        if (pos) {
          try {
            const dpr = window.devicePixelRatio || 1;
            const offset = view.posAtCoords({ x: pos.x / dpr, y: pos.y / dpr });
            if (offset != null) view.dispatch({ selection: { anchor: offset } });
          } catch {
            /* best-effort: keep current cursor */
          }
        }
        await insertImageFiles(images, view);
      }

      for (const filePath of others.slice(0, 20)) {
        await openPath(filePath);
      }
    });
  }

  // Prevent browser default drag-drop behavior (opening the file)
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());

  // Auto-focus editor when window gains focus
  window.addEventListener('focus', () => {
    const view = currentView();
    if (view) view.focus();
  });

  // Warn on window close if unsaved changes (Tauri).
  // Title/version are set earlier in init() so they appear ASAP.
  if (isLocalTauri()) {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const appWindow = getCurrentWindow();
    appWindow.onCloseRequested(async (event) => {
      const hasDirty = getAllTabs().some((t) => t.dirty);
      if (hasDirty) {
        event.preventDefault();
        showCloseAppDialog(async () => {
          const { exit } = await import('@tauri-apps/plugin-process');
          await exit(0);
        });
      }
    });
  }

  // Initialize AI Copilot
  initAICopilot(config);

  // Initialize AI Chat panel if copilot is enabled
  if (config.features?.ai_copilot && config.has_api_key) {
    const aiPanelContent = document.getElementById('ai-panel-content');
    if (aiPanelContent) {
      await initChatPanel(aiPanelContent, {
        getVaultPath: () => vaultPath,
        getActiveView: () => currentView(),
      });
      // Set initial doc context from current tab
      const activeTab = getActiveTab();
      if (activeTab) {
        updateDocContext(activeTab.path, activeTab.content);
      }
    }
  }

  // Initialize AI context menu (right-click on selected text)
  initContextMenu({
    getActiveView: () => currentView(),
    onAskAI: (selectedText) => {
      const app = document.getElementById('app');
      if (!app?.classList.contains('ai-panel-open')) {
        toggleAIPanel(selectedText);
      } else {
        updateSelectedContext(selectedText);
      }
      // Lazy-init chat panel if needed
      const aiPanelContent = document.getElementById('ai-panel-content');
      if (aiPanelContent && !aiPanelContent.hasChildNodes()) {
        initChatPanel(aiPanelContent, {
          getVaultPath: () => vaultPath,
          getActiveView: () => currentView(),
        });
        if (selectedText) updateSelectedContext(selectedText);
      }
      // Focus the chat textarea
      setTimeout(() => {
        const textarea = document.querySelector('.ai-chat-textarea');
        if (textarea) textarea.focus();
      }, 100);
    },
    onComposer: (view) => {
      openComposerForView(view);
    },
  });

  // AI panel close button
  const aiPanelClose = document.getElementById('ai-panel-close');
  if (aiPanelClose) {
    aiPanelClose.addEventListener('click', toggleAIPanel);
  }

  // AI panel resize handle
  const aiPanel = document.getElementById('ai-panel');
  if (aiPanel) {
    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'ai-panel-resize-handle';
    aiPanel.prepend(resizeHandle);

    let startX = 0;
    let startWidth = 0;

    resizeHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startWidth = aiPanel.getBoundingClientRect().width;
      const onMouseMove = (e) => {
        const delta = startX - e.clientX;
        const newWidth = Math.min(600, Math.max(200, startWidth + delta));
        document.documentElement.style.setProperty('--ai-panel-width', newWidth + 'px');
      };
      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  // Check for updates (non-blocking)
  checkForUpdates();
}

// ── Pane content/scroll callbacks ──────────────────────────

// Debounce the outline rebuild during typing — heading extraction is cheap
// but the resulting DOM diff isn't free, and we only need the outline to
// catch up when the user pauses.
const OUTLINE_DEBOUNCE_MS = 300;
let outlineDebounceTimer = null;
function scheduleOutlineUpdate(text) {
  if (outlineDebounceTimer) clearTimeout(outlineDebounceTimer);
  outlineDebounceTimer = setTimeout(() => {
    outlineDebounceTimer = null;
    updateOutline(text);
  }, OUTLINE_DEBOUNCE_MS);
}

function handlePaneContentChange(pane, newContent) {
  // Find the tab for the active pane
  const tab = getActiveTab();
  if (!tab) return;

  updateTabContent(tab.id, newContent);
  markDirty(tab.id);
  onContentChange(tab.path, newContent);

  // Update AI doc context with latest content
  updateDocContext(tab.path, newContent);

  // Outline updates ride a debounce so we don't rebuild the heading list on
  // every keystroke.
  scheduleOutlineUpdate(newContent);

  if (currentViewMode() === 'split' || currentViewMode() === 'preview') {
    const basePath = dirnameOf(tab.path);
    // Suppress the spurious preview→editor scroll sync caused by innerHTML
    // replacement. When renderMarkdown resets innerHTML the browser drops
    // scrollTop to 0, fires a scroll event, and handlePreviewScroll would
    // otherwise drag the editor back to line ≈1 on every keystroke (vim x,
    // delete, normal typing). Marking 'editor' as the recent sync source
    // makes handlePreviewScroll's lockout swallow that bounce.
    recordScrollSync('editor');
    // Also gate editor→preview sync for a short window. CM reflows line
    // wrap and may scrollIntoView the cursor on each keystroke, which
    // would otherwise drive syncPreviewToLine and shake the preview.
    typingLockoutUntil = Date.now() + TYPING_PREVIEW_SYNC_LOCKOUT_MS;
    const prevScrollTop = pane.previewContainer.scrollTop;
    renderPreview(newContent, basePath, pane.previewContainer, tab.path);
    // Preserve preview scroll position across re-render so the preview
    // doesn't visually jump to the top on every edit.
    pane.previewContainer.scrollTop = prevScrollTop;
  }

  scheduleSessionSave();
}

// Bidirectional scroll sync uses a short lockout: when one side drives a sync,
// the other side ignores its own scroll events for SCROLL_LOCKOUT_MS so the
// programmatic scrollTop assignment doesn't bounce back as a feedback loop.
const SCROLL_LOCKOUT_MS = 100;
let lastScrollSyncTime = 0;
let lastScrollSyncSource = null;

// Separate gate for editor scrolls that fire as side-effects of typing
// (line-wrap reflow, cursor scrollIntoView, etc.). Without this, every
// keystroke nudges the preview via syncPreviewToLine and the preview
// visually jitters. Tuned long enough to absorb the burst that follows
// a single character insert but short enough that the user's own scroll
// resumes syncing immediately after they stop typing.
const TYPING_PREVIEW_SYNC_LOCKOUT_MS = 250;
let typingLockoutUntil = 0;

function shouldHandleScroll(source) {
  if (lastScrollSyncSource && lastScrollSyncSource !== source) {
    if (Date.now() - lastScrollSyncTime < SCROLL_LOCKOUT_MS) return false;
  }
  return true;
}

function recordScrollSync(source) {
  lastScrollSyncTime = Date.now();
  lastScrollSyncSource = source;
}

function handlePaneScroll(pane, info) {
  const { topLine, ratio } = info || {};
  // Outline highlight tracks editor scroll directly — independent of preview
  // sync gating so the active heading stays correct even while the user is
  // typing.
  if (typeof topLine === 'number') setActiveOutlineLine(topLine);

  if (paneViewMode(pane) !== 'split' || !pane.previewContainer) return;
  // Skip preview sync while we're absorbing the editor-scroll burst that
  // immediately follows a doc-change. Otherwise the preview jitters with
  // every keystroke.
  if (Date.now() < typingLockoutUntil) return;
  if (!shouldHandleScroll('editor')) return;
  recordScrollSync('editor');
  if (typeof topLine === 'number') {
    syncPreviewToLine(pane.previewContainer, topLine);
  } else if (typeof ratio === 'number') {
    const maxScroll = pane.previewContainer.scrollHeight - pane.previewContainer.clientHeight;
    pane.previewContainer.scrollTop = maxScroll * ratio;
  }
}

function handlePreviewScroll(pane) {
  if (paneViewMode(pane) !== 'split' || !pane.editorView) return;
  if (!shouldHandleScroll('preview')) return;
  const line = getLineFromPreview(pane.previewContainer);
  if (line === null) return;
  recordScrollSync('preview');
  scrollEditorToLine(pane.editorView, line);
}

// Double-click in the preview → move the editor cursor to the matching source
// line. Mirrors the outline "jump to heading" wiring (recordScrollSync +
// jumpToLine), plus a flash so the landing spot is obvious.
function handlePreviewSourceJump(line, container) {
  const pane = getPaneByPreviewContainer(container) || getActivePane();
  if (!pane || !pane.editorView) return;
  // User-initiated move: suppress the bounce-back from the editor scroll we're
  // about to cause (same guard the outline jump uses).
  recordScrollSync('editor');
  // In preview-only mode the editor is hidden; reveal it so the cursor lands
  // somewhere visible (same policy as opening a file from the sidebar).
  if (currentViewMode() === 'preview') setViewMode('split');
  jumpToLine(pane.editorView, line);
  flashLine(pane.editorView, line);
}

function handleSelectionChange(selectedText) {
  // Only forward to chat when AI panel is open
  const app = document.getElementById('app');
  if (app?.classList.contains('ai-panel-open')) {
    updateSelectedContext(selectedText);
  }
}

// ── File handling ──────────────────────────────────────────
async function handleFileSelect(path) {
  try {
    // Images can't be loaded as text — open them in the pan/zoom viewer.
    if (isImagePath(path)) {
      // Open images as a read-only viewer tab (not as editable text).
      openTab(path, '', { kind: 'image' });
      highlightFile(path);
      if (currentViewMode() === 'preview') setViewMode('split');
      return;
    }
    const existed = getTabByPath(path);
    const content = await backend.readFile(path);
    const tab = openTab(path, content);
    // Establish the conflict-detection baseline only for a freshly loaded tab.
    if (!existed && tab) await markTabSynced(tab.id, content);
    highlightFile(path);
  } catch (e) {
    console.error('Failed to open file:', e);
    showToast(`ファイルを開けませんでした: ${e?.message || e}`, { type: 'error', duration: 6000 });
  }
}

/**
 * Open a file linked from the preview (GitHub-style browsing between files).
 * Text files land in a tab; anything unreadable as text (PDF, office docs, a
 * directory) is handed to the OS default application. `hash` scrolls the newly
 * rendered preview to the matching heading anchor.
 * @param {{path: string, hash: string}} target
 */
async function handlePreviewFileLink(target) {
  if (!target || !target.path) return;
  const { path, hash } = target;

  if (isImagePath(path)) {
    openTab(path, '', { kind: 'image' });
    highlightFile(path);
    if (currentViewMode() === 'preview') setViewMode('split');
    return;
  }

  let content;
  try {
    content = await backend.readFile(path);
  } catch (e) {
    // Not readable as UTF-8 text (binary, directory, or missing) - let the OS
    // decide what to do with it. A genuinely missing path fails here too and
    // surfaces as a toast.
    const opened = await openWithDefaultApp(path);
    if (!opened) {
      console.error('Failed to open linked file:', e);
      showToast(`リンク先を開けませんでした: ${path}`, { type: 'error', duration: 6000 });
    }
    return;
  }

  const existed = getTabByPath(path);
  const tab = openTab(path, content);
  if (!existed && tab) await markTabSynced(tab.id, content);
  highlightFile(path);
  if (hash) scrollPreviewToAnchor(hash);
}

/** Open a path with the OS default application. Returns false on failure. */
async function openWithDefaultApp(path) {
  if (!isLocalTauri()) return false;
  try {
    const { openPath: openWithOs } = await import('@tauri-apps/plugin-opener');
    await openWithOs(path);
    return true;
  } catch (e) {
    console.error('openPath failed:', e);
    return false;
  }
}

/**
 * Scroll the active pane's preview to an anchor id. The preview for a freshly
 * opened tab renders asynchronously, so retry for a short while before giving
 * up rather than scrolling an empty container.
 */
function scrollPreviewToAnchor(hash, attempt = 0) {
  const pane = getActivePane();
  const container = pane && pane.previewContainer;
  if (container && scrollToAnchor(container, hash)) return;
  if (attempt >= 10) return;
  setTimeout(() => scrollPreviewToAnchor(hash, attempt + 1), 50);
}

// ── Right-click context menus ──────────────────────────────

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('コピーしました', { duration: 1500 });
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      showToast('コピーしました', { duration: 1500 });
    } catch {
      showToast('コピーに失敗しました', { type: 'error' });
    }
  }
}

/** Path separator matching the given path's style (Windows vs POSIX). */
function joinPath(dir, name) {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return `${dir.replace(/[/\\]+$/, '')}${sep}${name}`;
}

function toRelative(path) {
  if (!vaultPath || !path) return path;
  const base = vaultPath.replace(/[/\\]+$/, '');
  if (path.startsWith(base)) return path.slice(base.length).replace(/^[/\\]+/, '') || path;
  return path;
}

async function revealInFileManager(path) {
  if (!isLocalTauri()) return;
  try {
    const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
    await revealItemInDir(path);
  } catch (e) {
    console.error('Reveal failed:', e);
    showToast(`ファイルマネージャで表示に失敗: ${e?.message || e}`, { type: 'error' });
  }
}

async function refreshTree() {
  if (!vaultPath) return;
  try {
    const tree = await backend.readDirTree(vaultPath, getShowAllFiles());
    loadDirectory(tree);
  } catch (e) {
    console.error('Failed to refresh tree:', e);
  }
}

async function doNewFile(entry) {
  const dir = entry.isDir ? entry.path : dirnameOf(entry.path);
  const name = await promptDialog('新規ファイル名', 'untitled.md', '作成');
  if (!name) return;
  const newPath = joinPath(dir, name);
  try {
    await backend.createFile(newPath);
    await refreshTree();
    await handleFileSelect(newPath);
  } catch (e) {
    showToast(`作成に失敗: ${e?.message || e}`, { type: 'error' });
  }
}

async function doNewFolder(entry) {
  const dir = entry.isDir ? entry.path : dirnameOf(entry.path);
  const name = await promptDialog('新規フォルダ名', 'new-folder', '作成');
  if (!name) return;
  try {
    await backend.createDirectory(joinPath(dir, name));
    await refreshTree();
  } catch (e) {
    showToast(`作成に失敗: ${e?.message || e}`, { type: 'error' });
  }
}

async function doRename(entry) {
  const name = await promptDialog('新しい名前', entry.name, '変更');
  if (!name || name === entry.name) return;
  const newPath = joinPath(dirnameOf(entry.path), name);
  try {
    await backend.renamePath(entry.path, newPath);
    const tab = getAllTabs().find((t) => t.path === entry.path);
    if (tab) updateTabPath(tab.id, newPath);
    await refreshTree();
  } catch (e) {
    showToast(`名前変更に失敗: ${e?.message || e}`, { type: 'error' });
  }
}

async function doDelete(entry) {
  const ok = await confirmDialog(`「${entry.name}」をゴミ箱に移動しますか？`, {
    okLabel: '削除',
    danger: true,
  });
  if (!ok) return;
  try {
    await backend.deletePath(entry.path);
    const tab = getAllTabs().find((t) => t.path === entry.path);
    if (tab) closeTab(tab.id);
    await refreshTree();
  } catch (e) {
    showToast(`削除に失敗: ${e?.message || e}`, { type: 'error' });
  }
}

function openInNewWindow(path) {
  backend.newWindow(path).catch((e) => {
    showToast(`ウィンドウを開けませんでした: ${e?.message || e}`, { type: 'error' });
  });
}

function handleFileContextMenu(entry, x, y) {
  const items = [];
  if (!entry.isDir) {
    items.push({ label: '開く', action: () => handleFileSelect(entry.path) });
    if (isLocalTauri()) {
      items.push({ label: '新しいウィンドウで開く', action: () => openInNewWindow(entry.path) });
    }
  }
  items.push(
    { label: 'パスをコピー', action: () => copyText(entry.path) },
    { label: '相対パスをコピー', action: () => copyText(toRelative(entry.path)) },
    { label: 'ファイル名をコピー', action: () => copyText(entry.name) },
    { separator: true },
    { label: 'ファイルマネージャで表示', action: () => revealInFileManager(entry.path) },
    { separator: true },
    { label: '新規ファイル…', action: () => doNewFile(entry) },
    { label: '新規フォルダ…', action: () => doNewFolder(entry) },
    { label: '名前を変更…', action: () => doRename(entry) },
    { label: '削除（ゴミ箱へ）', danger: true, action: () => doDelete(entry) },
  );
  showMenu(x, y, items);
}

function handleTabContextMenu(tabId, x, y) {
  const tab = getAllTabs().find((t) => t.id === tabId);
  if (!tab) return;
  const items = [];
  // Only text tabs have editable content worth copying (image viewers don't).
  if (tab.kind !== 'image') {
    items.push({ label: 'タブを複製', action: () => duplicateTab(tabId) }, { separator: true });
  }
  items.push(
    { label: '閉じる', action: () => closeTab(tabId) },
    { label: '他のタブを閉じる', action: () => closeOtherTabs(tabId) },
    { label: '右側のタブを閉じる', action: () => closeTabsToRight(tabId) },
    { label: 'すべて閉じる', action: () => closeAllTabs() },
  );
  if (tab.path) {
    items.push({ separator: true });
    if (isLocalTauri()) {
      items.push({ label: '新しいウィンドウで開く', action: () => openInNewWindow(tab.path) });
    }
    items.push(
      { label: 'パスをコピー', action: () => copyText(tab.path) },
      { label: 'ファイル名をコピー', action: () => copyText(getFilename(tab.path)) },
      { separator: true },
      { label: 'ファイルマネージャで表示', action: () => revealInFileManager(tab.path) },
    );
  }
  showMenu(x, y, items);
}

/**
 * Open a path, auto-detecting whether it is a folder (→ load as vault) or a
 * file (→ open in a tab). Resolves to `true` on success, `false` if the path
 * could not be opened as either (e.g. it does not exist). Callers that don't
 * care about the outcome can ignore the return value.
 */
async function openPath(path) {
  try {
    const tree = await backend.readDirTree(path, getShowAllFiles());
    vaultPath = path;
    loadDirectory(tree);
    watchVault(vaultPath);
    return true;
  } catch {
    try {
      const existed = getTabByPath(path);
      const content = await backend.readFile(path);
      const tab = openTab(path, content);
      if (!existed && tab) await markTabSynced(tab.id, content);
      return true;
    } catch (e) {
      console.error('Failed to open path:', e);
      return false;
    }
  }
}

// ── Go to path (open a file or folder by typing its path) ──
async function handleGoToPath() {
  const raw = await promptDialog('開くパスを入力（ファイル / フォルダ）', vaultPath || '', '開く');
  if (raw == null) return; // cancelled
  let home;
  try {
    home = await backend.getOpenDir();
  } catch {
    home = '';
  }
  const path = normalizeInputPath(raw, home);
  if (!path) return;
  const ok = await openPath(path);
  if (ok) {
    scheduleSessionSave();
  } else {
    showToast(`開けませんでした: ${path}`, { type: 'error', duration: 6000 });
  }
}

// ── Print (preview / editor) ───────────────────────────────
let _printer = null;
async function getPrinter() {
  if (_printer) return _printer;
  const [{ createPrinter }, { highlightCode }] = await Promise.all([
    import('./features/print/print.js'),
    import('./core/code-highlight.js'),
  ]);
  _printer = createPrinter({
    renderPreview,
    highlightCode,
    dirname: dirnameOf,
    onError: (m) => showToast(m, { type: 'error', duration: 6000 }),
    cssHref: 'style.css',
  });
  return _printer;
}

/**
 * Print the active document.
 * @param {'preview'|'editor'} kind
 */
async function runPrint(kind) {
  const tab = getActiveTab();
  if (!tab) return;
  try {
    const printer = await getPrinter();
    if (kind === 'editor') await printer.printEditor(tab);
    else await printer.printPreview(tab);
  } catch (e) {
    console.error('Print failed:', e);
    showToast(`印刷に失敗しました: ${e?.message || e}`, { type: 'error', duration: 6000 });
  }
}

/** Ctrl+P: print what the current view shows (editor-only → source, else preview). */
function printActive() {
  return runPrint(currentViewMode() === 'editor' ? 'editor' : 'preview');
}

/** Render an image file into a pane's main area as a pan/zoom viewer. */
function renderImageTab(pane, tab) {
  if (pane.previewContainer) pane.previewContainer.innerHTML = '';
  const container = pane.editorContainer;
  if (!container) return;
  container.innerHTML = '';
  const holder = document.createElement('div');
  holder.className = 'puml-diagram image-view';
  const img = document.createElement('img');
  img.src = isLocalTauri() ? convertFileSrc(tab.path) : tab.path;
  img.alt = tab.name || '';
  img.draggable = false;
  holder.appendChild(img);
  container.appendChild(holder);
  // Enable pan/zoom once the image has dimensions (and immediately, idempotently).
  attachPanZoom(holder);
  img.addEventListener('load', () => attachPanZoom(holder), { once: true });
}

// ── Tab change handler ─────────────────────────────────────
function handleTabChange(tab) {
  const pane = getActivePane();
  if (!pane) return;

  const editorContainer = pane.editorContainer;
  const previewContainer = pane.previewContainer;

  if (!tab) {
    if (editorContainer) {
      editorContainer.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-title">Fude</div>
          <div class="empty-state-hint"><kbd>Ctrl+O</kbd> Open file &nbsp; <kbd>Ctrl+Shift+O</kbd> Open folder &nbsp; <kbd>Ctrl+Shift+T</kbd> New tab</div>
        </div>`;
    }
    if (previewContainer) previewContainer.innerHTML = '';
    pane.editorView = null;
    pane.filePath = null;
    pane.content = '';
    clearOutline();
    return;
  }

  // Image tabs are a read-only viewer, not a text editor.
  if (tab.kind === 'image') {
    renderImageTab(pane, tab);
    pane.filePath = tab.path;
    pane.content = '';
    pane.editorView = null;
    if (tab.path) highlightFile(tab.path);
    clearOutline();
    applyViewMode();
    scheduleSessionSave();
    return;
  }

  // Create a new editor in the active pane (pass the path so source code mode
  // can pick the right language).
  const view = createEditorInPane(pane, tab.content, { filePath: tab.path });

  // Update pane file tracking
  pane.filePath = tab.path;
  pane.content = tab.content;
  pane.dirty = tab.dirty;

  // Source code mode: a Markdown preview of source code is meaningless, so force
  // this tab to editor-only on open. The user can still switch views manually.
  if (shouldOpenAsCode(tab.path, sourceCodeModeEnabled) && getTabViewMode(tab.id) !== 'editor') {
    setTabViewMode(tab.id, 'editor');
  }

  // Apply vim mode
  reapplyMode();

  // Apply this tab's view mode FIRST (sets pane classes / editor width and
  // renders preview). Scroll geometry depends on the editor width (line wrap),
  // so the width must be settled before we restore the scroll position.
  applyViewMode();

  // Restore cursor immediately; restore scroll after the layout reflow that the
  // view-mode (width) change above triggers, otherwise a line-based scroll is
  // computed against the wrong width and the view lands on a different line.
  if (tab.cursor) setCursor(view, tab.cursor.from || 0, tab.cursor.to || 0);
  if (tab.scroll && view) {
    const scroll = tab.scroll;
    requestAnimationFrame(() => setScroll(view, scroll));
  }

  if (tab.path) highlightFile(tab.path);

  // Update AI doc context
  updateDocContext(tab.path, tab.content);

  // Refresh outline for the newly active document
  updateOutline(tab.content);

  // Focus editor after tab switch
  if (view) view.focus();

  // Save session on tab change
  scheduleSessionSave();
}

// ── File watching / reload ─────────────────────────────────

function handleTabPathChange({ oldPath, newPath }) {
  if (oldPath) {
    // Only unwatch if no other tab still references this path.
    const stillOpen = getAllTabs().some((t) => t.path === oldPath);
    if (!stillOpen) unwatchFile(oldPath);
  }
  if (newPath) {
    const others = getAllTabs().filter((t) => t.path === newPath);
    if (others.length <= 1) watchFile(newPath);
  }
}

function getFilename(p) {
  return p.split('/').pop().split('\\').pop();
}

function applyReloadToAllPanes(path, content, tabId) {
  // Update editor content in every pane displaying this path
  const allPanes = panesModule.getAllPanes();
  for (const p of allPanes) {
    if (p.filePath === path && p.editorView) {
      // setContentFromDisk also handles cursor + scroll restoration
      setContentFromDisk(p.editorView, content);
      p.content = content;
      // Re-render preview if visible
      const mode = paneViewMode(p);
      if ((mode === 'split' || mode === 'preview') && p.previewContainer) {
        const basePath = dirnameOf(path);
        renderPreview(content, basePath, p.previewContainer, path);
      }
    }
  }
  updateTabContent(tabId, content);
  markClean(tabId);
  // Editor now matches disk → refresh the baseline for conflict detection.
  markTabSynced(tabId, content);
  updateDocContext(path, content);

  // The disk-reload transaction is annotated so the editor's onChange never
  // fires, so scheduleOutlineUpdate is bypassed too. Refresh the outline here
  // when the reloaded file is the one the outline is showing (the active tab),
  // otherwise the heading list goes stale after an external change.
  const activeTab = getActiveTab();
  if (activeTab && activeTab.path === path) updateOutline(content);
}

async function handleExternalFileChange(path) {
  const tab = getAllTabs().find((t) => t.path === path);
  if (!tab) return;

  if (tab.dirty) {
    showReloadBanner(
      `"${getFilename(path)}" が外部で変更されました。未保存の変更を破棄して再読込しますか？`,
      async () => {
        const content = await reloadFromDisk(path, null);
        if (content !== null) applyReloadToAllPanes(path, content, tab.id);
      },
    );
    return;
  }

  try {
    const content = await backend.readFile(path);
    applyReloadToAllPanes(path, content, tab.id);
  } catch (e) {
    console.error('Auto-reload failed:', e);
  }
}

async function manualReload() {
  const tab = getActiveTab();
  if (!tab || !tab.path) return;

  const doReload = async () => {
    try {
      const content = await backend.readFile(tab.path);
      applyReloadToAllPanes(tab.path, content, tab.id);
      dismissReloadBanner();
    } catch (e) {
      console.error('Manual reload failed:', e);
    }
  };

  if (tab.dirty) {
    showConfirmDialog(
      `"${getFilename(tab.path)}" には未保存の変更があります。破棄して再読込しますか？`,
      doReload,
      '再読込',
    );
  } else {
    await doReload();
  }
}

// ── View mode ──────────────────────────────────────────────
// Each pane reflects the view mode of the tab it currently displays, so
// switching tabs (or focusing a different pane) shows that file's own layout.
/** タブバーのボタンに現在の表示モードを反映する */
function syncViewModeButtons() {
  const mode = currentViewMode();
  document.querySelectorAll('.view-mode-btn').forEach((btn) => {
    const on = btn.dataset.mode === mode;
    btn.classList.toggle('active', on);
    // 現在のモードを支援技術にも伝える（見た目だけの active に留めない）
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function applyViewMode() {
  syncViewModeButtons();
  const allPanes = panesModule.getAllPanes();
  for (const p of allPanes) {
    const mode = paneViewMode(p);
    p.element.classList.remove('view-split', 'view-preview');
    if (mode === 'split') p.element.classList.add('view-split');
    else if (mode === 'preview') p.element.classList.add('view-preview');
    // 'editor' => no class (editor-only).

    if ((mode === 'split' || mode === 'preview') && p.previewContainer) {
      const tab = p.filePath ? getAllTabs().find((t) => t.path === p.filePath) : getActiveTab();
      if (tab) {
        const basePath = dirnameOf(tab.path);
        renderPreview(tab.content, basePath, p.previewContainer, tab.path);
      }
    }
  }
}

function setViewMode(mode) {
  const tab = getActiveTab();
  if (tab) setTabViewMode(tab.id, mode);
  // Remember the most recently chosen mode as the default for new tabs.
  defaultViewMode = mode;
  applyViewMode();
  scheduleSessionSave();
}

// ── Recovery dialog ────────────────────────────────────────
function showRecoveryDialog(fileNames, onRecover, onDiscard) {
  const overlay = document.createElement('div');
  overlay.className = 'settings-overlay';
  overlay.innerHTML = `
    <div class="settings-panel" style="width:400px">
      <div class="settings-body" style="padding:20px">
        <p style="margin-bottom:8px;color:var(--fg-primary);font-weight:600">未保存の編集が見つかりました</p>
        <p style="margin-bottom:16px;color:var(--fg-secondary);font-size:13px">${fileNames}</p>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button class="btn-discard" style="padding:6px 16px;background:var(--bg-tertiary);color:var(--fg-primary);border:1px solid var(--border);border-radius:4px;cursor:pointer">破棄</button>
          <button class="btn-recover" style="padding:6px 16px;background:var(--fg-accent);color:#fff;border:none;border-radius:4px;cursor:pointer">復元</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector('.btn-discard').addEventListener('click', () => {
    overlay.remove();
    if (onDiscard) onDiscard();
  });
  overlay.querySelector('.btn-recover').addEventListener('click', () => {
    overlay.remove();
    if (onRecover) onRecover();
  });
}

// ── Close app dialog ───────────────────────────────────────
function showConfirmDialog(message, onConfirm, confirmLabel = '実行') {
  const overlay = document.createElement('div');
  overlay.className = 'settings-overlay';
  overlay.innerHTML = `
    <div class="settings-panel" style="width:400px">
      <div class="settings-body" style="padding:20px">
        <p style="margin-bottom:16px;color:var(--fg-primary)"></p>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button class="btn-cancel" style="padding:6px 16px;background:var(--bg-tertiary);color:var(--fg-primary);border:1px solid var(--border);border-radius:4px;cursor:pointer">キャンセル</button>
          <button class="btn-confirm" style="padding:6px 16px;background:#d32f2f;color:#fff;border:none;border-radius:4px;cursor:pointer"></button>
        </div>
      </div>
    </div>
  `;
  overlay.querySelector('p').textContent = message;
  overlay.querySelector('.btn-confirm').textContent = confirmLabel;
  document.body.appendChild(overlay);

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const confirm = () => {
    close();
    onConfirm();
  };
  const onKey = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      confirm();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);

  overlay.querySelector('.btn-cancel').addEventListener('click', close);
  overlay.querySelector('.btn-confirm').addEventListener('click', confirm);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  overlay.querySelector('.btn-confirm').focus();
}

function showCloseAppDialog(onConfirm) {
  const dirtyTabs = getAllTabs().filter((t) => t.dirty);
  const names = dirtyTabs.map((t) => (t.path ? t.path.split('/').pop() : 'Untitled')).join(', ');
  const overlay = document.createElement('div');
  overlay.className = 'settings-overlay';
  overlay.innerHTML = `
    <div class="settings-panel" style="width:400px">
      <div class="settings-body" style="padding:20px">
        <p style="margin-bottom:8px;color:var(--fg-primary);font-weight:600">未保存のファイルがあります</p>
        <p style="margin-bottom:16px;color:var(--fg-secondary);font-size:13px">${names}</p>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button class="btn-cancel" style="padding:6px 16px;background:var(--bg-tertiary);color:var(--fg-primary);border:1px solid var(--border);border-radius:4px;cursor:pointer">キャンセル</button>
          <button class="btn-confirm" style="padding:6px 16px;background:#d32f2f;color:#fff;border:none;border-radius:4px;cursor:pointer">保存せず終了</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const confirm = () => {
    close();
    onConfirm();
  };
  const onKey = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      confirm();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);

  overlay.querySelector('.btn-cancel').addEventListener('click', close);
  overlay.querySelector('.btn-confirm').addEventListener('click', confirm);

  overlay.querySelector('.btn-confirm').focus();
}

// ── Session save ───────────────────────────────────────────
// ── Menu bar ───────────────────────────────────────────────
/**
 * Build the menu bar definition. Every item delegates to an existing action so
 * the menu and the keyboard shortcuts stay in sync. Editor commands receive the
 * active view; they no-op when there's no editor.
 */
function buildMenuDefinition() {
  const withView = (fn) => () => {
    const v = currentView();
    if (v) fn(v);
  };
  return [
    {
      label: 'ファイル(F)',
      accessKey: 'F',
      items: [
        { label: '新規タブ', shortcut: 'Ctrl+Shift+T', action: () => openTab(null, '') },
        {
          label: '新しいウィンドウ',
          shortcut: 'Ctrl+Shift+N',
          action: () => backend.newWindow(null),
        },
        { label: 'ファイルを開く', shortcut: 'Ctrl+O', action: handleOpenFile },
        { label: 'フォルダを開く', shortcut: 'Ctrl+Shift+O', action: handleOpenFolder },
        { label: 'パスを開く', shortcut: 'Ctrl+Shift+P', action: handleGoToPath },
        { separator: true },
        { label: '保存', shortcut: 'Ctrl+S', action: () => performSave({}) },
        {
          label: '名前を付けて保存',
          shortcut: 'Ctrl+Shift+S',
          action: () => performSave({ forceDialog: true }),
        },
        { label: '再読込', shortcut: 'Ctrl+Shift+R', action: manualReload },
        { separator: true },
        { label: '印刷（プレビュー）', shortcut: 'Ctrl+P', action: () => runPrint('preview') },
        { label: '印刷（エディタ）', action: () => runPrint('editor') },
        { separator: true },
        { label: '閉じる', shortcut: 'Ctrl+Shift+W', action: smartClose },
      ],
    },
    {
      label: '編集(E)',
      accessKey: 'E',
      items: [
        { label: '太字', shortcut: 'Ctrl+B', action: withView(toggleBold) },
        { label: '箇条書き', shortcut: 'Ctrl+Shift+8', action: withView(toggleBullet) },
        { label: '番号付きリスト', shortcut: 'Ctrl+Shift+7', action: withView(toggleNumbered) },
        { separator: true },
        { label: '検索・置換', shortcut: 'Ctrl+F', action: withView(openSearch) },
      ],
    },
    {
      label: '挿入(I)',
      accessKey: 'I',
      items: [{ label: '表…', shortcut: 'Ctrl+Shift+G', action: openTableGridPicker }],
    },
    {
      label: '表示(V)',
      accessKey: 'V',
      items: [
        { label: 'エディタのみ', shortcut: 'Ctrl+Shift+J', action: () => setViewMode('editor') },
        { label: '分割', shortcut: 'Ctrl+Shift+K', action: () => setViewMode('split') },
        { label: 'プレビューのみ', shortcut: 'Ctrl+Shift+L', action: () => setViewMode('preview') },
        { separator: true },
        { label: '縦分割', shortcut: 'Ctrl+Shift+D', action: splitVertical },
        { label: '横分割', shortcut: 'Ctrl+Shift+H', action: splitHorizontal },
        { separator: true },
        { label: 'サイドバー表示切替', action: toggleSidebar },
        {
          label: '文字を拡大',
          shortcut: 'Ctrl++',
          action: () => setFontSize(Math.min(32, getFontSize() + 1)),
        },
        {
          label: '文字を縮小',
          shortcut: 'Ctrl+-',
          action: () => setFontSize(Math.max(10, getFontSize() - 1)),
        },
      ],
    },
    {
      label: 'AI(A)',
      accessKey: 'A',
      items: [
        { label: 'AIチャット', shortcut: 'Ctrl+Shift+I', action: () => toggleAIPanel() },
        {
          label: 'AIコンポーザー',
          shortcut: 'Ctrl+Shift+C',
          action: withView(openComposerForView),
        },
      ],
    },
    {
      label: 'ヘルプ(H)',
      accessKey: 'H',
      items: [
        { label: '設定', shortcut: 'Ctrl+,', action: openSettings },
        { label: 'モード切替', shortcut: 'Ctrl+Shift+M', action: cycleMode },
        { separator: true },
        {
          label: '更新を確認',
          action: () =>
            checkForUpdates({ manual: true, notify: (msg, type) => showToast(msg, { type }) }),
        },
        { label: 'ヘルプ', shortcut: 'Ctrl+?', action: openHelp },
      ],
    },
  ];
}

// ── Table insertion ────────────────────────────────────────
/** Open the grid popover near the caret and insert the chosen table. */
function openTableGridPicker() {
  const view = currentView();
  if (!view) return;
  const coords = view.coordsAtPos(view.state.selection.main.head);
  const x = coords ? coords.left : window.innerWidth / 2;
  const y = coords ? coords.bottom + 4 : window.innerHeight / 2;
  showTableGridPicker(x, y, (rows, cols) => insertTable(view, rows, cols));
}

/** Insert a blank, aligned table (rows includes the header row) at the cursor. */
function insertTable(view, rows, cols) {
  const text = formatTableText(emptyTableModel(rows - 1, cols));
  const { state } = view;
  const { from, to } = state.selection.main;
  const before = state.sliceDoc(state.doc.lineAt(from).from, from);
  const after = state.sliceDoc(to, state.doc.lineAt(to).to);
  let insert = text;
  let lead = 0;
  if (before.trim() !== '') {
    insert = '\n' + insert;
    lead = 1;
  }
  if (after.trim() !== '') insert = insert + '\n';
  // Place the cursor in the first header cell (after the leading "| ").
  const cursorPos = from + lead + 2;
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: cursorPos },
    scrollIntoView: true,
  });
  view.focus();
}

function scheduleSessionSave() {
  // Only the main window owns the global session; additional windows must not
  // overwrite it with their own (transient) state.
  if (!isMainWindow) return;
  scheduleSave(() => ({
    open_tabs: getTabsForSession(),
    active_tab: getActiveTabIndex(),
    vault_path: vaultPath || null,
    view_mode: defaultViewMode,
    sidebar_visible: !document.getElementById('app')?.classList.contains('sidebar-collapsed'),
    pane_layout: null,
  }));
}

// ── Refresh sidebar ────────────────────────────────────────
async function refreshSidebar() {
  if (!vaultPath) return;
  try {
    const tree = await backend.readDirTree(vaultPath, getShowAllFiles());
    loadDirectory(tree);
  } catch {
    /* ignore */
  }
}

// ── Sidebar settings change handler ────────────────────────
async function handleSidebarSettingsChange({ sort, showAllFiles: allFiles }) {
  // Save to config
  try {
    const existing = await backend.getConfig();
    await backend.saveConfig({
      ...existing,
      sidebar_sort: sort,
      sidebar_show_all_files: allFiles,
    });
  } catch {
    /* ignore */
  }

  // Refresh tree if showAllFiles changed (needs re-fetch)
  await refreshSidebar();
}

// ── Open folder dialog ─────────────────────────────────────
async function handleOpenFile() {
  try {
    if (isLocalTauri()) {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const mdFilter = {
        name: 'Markdown / Text',
        extensions: ['md', 'markdown', 'mdown', 'mkd', 'mdx', 'qmd', 'txt'],
      };
      const allFilter = { name: 'All Files', extensions: ['*'] };
      // In source code mode, default to All Files so any source file is pickable.
      const filters = sourceCodeModeEnabled ? [allFilter, mdFilter] : [mdFilter, allFilter];
      const selected = await open({ directory: false, multiple: false, filters });
      if (selected) await handleFileSelect(selected);
    } else {
      showToast('このモードではファイルを開く操作に未対応です（フォルダを開いてください）', {
        type: 'error',
        duration: 6000,
      });
    }
  } catch (e) {
    console.error('Failed to open file:', e);
    showToast(`ファイルを開けませんでした: ${e?.message || e}`, { type: 'error', duration: 8000 });
  }
}

async function handleOpenFolder() {
  try {
    if (isLocalTauri()) {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const folder = await open({ directory: true, multiple: false });
      if (folder) {
        vaultPath = folder;
        const tree = await backend.readDirTree(folder, getShowAllFiles());
        loadDirectory(tree);
        watchVault(vaultPath);
        scheduleSessionSave();
        if (!tree || tree.length === 0) {
          showToast(
            'このフォルダに表示できるファイルがありません（設定で「全ファイル表示」を試してください）',
            {
              duration: 6000,
            },
          );
        }
      }
    } else {
      openFolderPicker(async (folder) => {
        vaultPath = folder;
        const tree = await backend.readDirTree(folder, getShowAllFiles());
        loadDirectory(tree);
        watchVault(vaultPath);
        scheduleSessionSave();
      });
    }
  } catch (e) {
    console.error('Failed to open folder:', e);
    showToast(`フォルダを開けませんでした: ${e?.message || e}`, { type: 'error', duration: 8000 });
  }
}

// ── Helpers ────────────────────────────────────────────────

/** Save the current active pane's tab state (cursor, scroll) before switching. */
function saveActivePaneTabState() {
  const view = currentView();
  if (!view) return;
  const tab = getActiveTab();
  if (!tab) return;
  updateTabCursor(tab.id, getCursor(view));
  updateTabScroll(tab.id, getScroll(view));
}

// ── Global keyboard shortcuts ──────────────────────────────
// Save the active tab to disk. Used by Ctrl+Shift+S (save) and Ctrl+Alt+S (save as).
async function performSave({ forceDialog }) {
  const tab = getActiveTab();
  const view = currentView();
  if (!tab || tab.kind === 'image' || !view) return;
  const content = getContent(view);

  // Quick path: existing path + not forcing dialog → save with a conflict check
  if (tab.path && !forceDialog) {
    await saveWithConflictCheck(tab, content);
    return;
  }

  // Dialog path (no path yet, or explicit Save As)
  try {
    let filePath;
    if (isLocalTauri()) {
      const { save } = await import('@tauri-apps/plugin-dialog');
      filePath = await save({
        filters: [{ name: 'Markdown', extensions: ['md', 'qmd'] }],
        defaultPath: tab.path || vaultPath || undefined,
      });
    } else {
      openSavePicker(tab.path || vaultPath || '', async (filePath) => {
        const ok = await triggerSave(filePath, content);
        if (ok) {
          updateTabPath(tab.id, filePath);
          markClean(tab.id);
          await markTabSynced(tab.id, content);
          refreshSidebar();
        }
      });
      return;
    }
    if (filePath) {
      const ok = await triggerSave(filePath, content);
      if (ok) {
        updateTabPath(tab.id, filePath);
        markClean(tab.id);
        await markTabSynced(tab.id, content);
        refreshSidebar();
      }
    }
  } catch (err) {
    console.error('Save failed:', err);
  }
}

/** Set a tab's disk-sync baseline hash to match the given content. */
async function markTabSynced(tabId, content) {
  const hash = await sha256Hex(content);
  if (hash) setTabDiskHash(tabId, hash);
}

/**
 * Save to an existing file, but first verify it wasn't changed on disk since we
 * last synced. On conflict, show a diff and let the user overwrite, reload the
 * disk version, or cancel. Independent of the async file watcher (and works in
 * browser mode where there is no watcher).
 */
async function saveWithConflictCheck(tab, content) {
  let diskContent = null;
  try {
    diskContent = await backend.readFile(tab.path);
  } catch {
    diskContent = null; // missing/unreadable → nothing to conflict with
  }

  if (diskContent != null) {
    const currentDiskHash = await sha256Hex(diskContent);
    const warn = shouldWarnConflict({
      loadedHash: getTabDiskHash(tab.id),
      currentDiskHash,
      diskContent,
      editorContent: content,
    });
    if (warn) {
      showConflictDialog({
        fileName: getFilename(tab.path),
        diskContent,
        editorContent: content,
        onOverwrite: () => finalizeSave(tab, content),
        onReload: () => applyReloadToAllPanes(tab.path, diskContent, tab.id),
        onCancel: () => {},
      });
      return;
    }
  }

  await finalizeSave(tab, content);
}

/** Write content to the tab's path and update clean/baseline state. */
async function finalizeSave(tab, content) {
  const ok = await triggerSave(tab.path, content);
  if (ok) {
    markClean(tab.id);
    await markTabSynced(tab.id, content);
    refreshSidebar();
  }
}

// Smart close: pane if multiple panes exist, otherwise the active tab.
function smartClose() {
  if (getPaneCount() > 1) {
    closeActivePane();
  } else {
    const active = getActiveTab();
    if (active) closeTab(active.id);
  }
}

// Alt の単押しでメニューバーを開く（Windows のメニューバーと同じ作法）。
// Alt+文字は組み合わせなので、Emacs モードでは M-f 等を奪わないよう
// 単押しだけを有効にする。
const altTap = createAltTap({ onTap: () => focusMenuBar() });

function handleGlobalKeys(e) {
  // メニューが開いている間は左右で隣のメニューへ移る
  if (isMenuOpen() && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
    if (moveOpenMenu(e.key === 'ArrowRight' ? 1 : -1)) {
      e.preventDefault();
      return;
    }
  }

  // Alt+key shortcuts (browser-friendly fallbacks; harmless in Tauri)
  if (e.altKey && !e.ctrlKey) {
    // In Emacs mode, let Alt-* fall through to CodeMirror (M-b/f/v/d/w etc.).
    // 単押し（altTap）だけは keyup 側で拾うので、ここで return してよい。
    if (getMode() === 'emacs') return;
    // Alt+F/E/V/... はメニューバーのアクセスキー。該当が無ければ従来の
    // Alt ショートカット（Alt+N/T/W/O）に落ちる。
    if (e.key.length === 1 && openMenuByAccessKey(e.key)) {
      e.preventDefault();
      return;
    }
    switch (e.key) {
      case 'n':
      case 't':
        e.preventDefault();
        openTab(null, '');
        return;
      case 'w': {
        e.preventDefault();
        smartClose();
        return;
      }
      case 'o':
        e.preventDefault();
        handleOpenFolder();
        return;
    }
  }

  // Escape inside a side pane (filer / outline / AI panel) returns focus to the
  // editor. Scoped to those panes so the editor's own Escape handling
  // (Vim/Emacs insert exit, inline-completion dismiss) is never disturbed.
  if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const active = document.activeElement;
    const sidebar = document.getElementById('sidebar');
    const aiPanel = document.getElementById('ai-panel');
    if ((sidebar && sidebar.contains(active)) || (aiPanel && aiPanel.contains(active))) {
      e.preventDefault();
      e.stopPropagation();
      focusActiveEditor();
    }
    return;
  }

  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;

  // Tab switching, handled up-front and uniformly so it works in every editor
  // mode (Normal/Vim/Emacs). The key→action mapping lives in the pure
  // tabActionForKey() so it stays testable. Ctrl+PageDown/PageUp are kept as
  // focus-neutral aliases of Ctrl+Tab / Ctrl+Shift+Tab because on Linux
  // (WebKitGTK) Ctrl+Shift+Tab is swallowed as backward focus navigation and
  // never reaches JS — PageUp/PageDown always do (matches browsers / VS Code).
  const tabAction = tabActionForKey(e);
  if (tabAction) {
    e.preventDefault();
    e.stopPropagation();
    saveActivePaneTabState();
    if (tabAction === 'next') nextTab();
    else prevTab();
    return;
  }

  // Bare Ctrl+letter is reserved for the editor (CodeMirror / Vim / Emacs).
  // We preventDefault on keys whose browser default would be intrusive
  // (Save Page, refresh, close window, etc.) but otherwise let CodeMirror handle.
  if (!e.shiftKey && !e.altKey) {
    // Bare Ctrl + non-letter app shortcuts. Intercepted BEFORE the
    // editor-pass-through below so they survive in vim/emacs modes too
    // (they don't conflict with editor keybindings).
    switch (e.key) {
      case ',':
        e.preventDefault();
        e.stopPropagation();
        openSettings();
        return;
      case '-':
        e.preventDefault();
        e.stopPropagation();
        setFontSize(Math.max(10, getFontSize() - 1));
        return;
      case '=':
      case '+':
        e.preventDefault();
        e.stopPropagation();
        setFontSize(Math.min(32, getFontSize() + 1));
        return;
      case 'ArrowLeft':
        e.preventDefault();
        e.stopPropagation();
        focusPane('left');
        return;
      case 'ArrowRight':
        e.preventDefault();
        e.stopPropagation();
        focusPane('right');
        return;
      case 'ArrowUp':
        e.preventDefault();
        e.stopPropagation();
        focusPane('up');
        return;
      case 'ArrowDown':
        e.preventDefault();
        e.stopPropagation();
        focusPane('down');
        return;
    }

    // Ctrl+S = Save (conventional). Skipped in Emacs, where Ctrl+S is isearch
    // and saving is done with the native C-x C-s chord instead.
    if (e.key === 's' && getMode() !== 'emacs') {
      e.preventDefault();
      e.stopPropagation();
      performSave({ forceDialog: false });
      return;
    }

    // Ctrl+O = Open File (normal mode only; vim/emacs keep Ctrl-O for the
    // editor and use the File menu instead).
    if (isOpenFileShortcut(e, getMode())) {
      e.preventDefault();
      e.stopPropagation();
      handleOpenFile();
      return;
    }

    // Ctrl+P = Print (normal mode only). Intercept so the browser doesn't print
    // the whole app window; vim/emacs keep Ctrl-P for the editor and print via
    // the File menu instead.
    if (isPrintShortcut(e, getMode())) {
      e.preventDefault();
      e.stopPropagation();
      printActive();
      return;
    }

    const blockBrowserDefault = ['s', 'r', 'w', 't', 'n', 'o', 'u'];
    if (blockBrowserDefault.includes(e.key)) {
      // CRITICAL: do NOT preventDefault in emacs mode. CodeMirror's runHandlers
      // checks event.defaultPrevented and skips ALL handlers (including emacs's
      // keymap) if it's already true. So calling preventDefault here would block
      // Ctrl+S/W/N/R from reaching emacs (kill-region, isearch, etc.).
      // In Vim mode the vim plugin swallows everything anyway, so it's safe.
      // In Normal mode we still want to block browser defaults.
      if (getMode() !== 'emacs') {
        e.preventDefault();
      }
      return;
    }
    // All bare Ctrl+letter keys pass through to CodeMirror / Vim / Emacs.
    // (AI Chat is on Ctrl+Shift+I, AI Composer on Ctrl+Shift+C — handled below.
    // Ctrl+I is left free for the editor, e.g. italic conventions.)
    return;
  }

  // From here on, modifier-laden combos. Ctrl+Shift+letter = app actions.
  //
  // Normalize single-character keys to uppercase before matching. With Shift
  // held, e.key for a letter is normally the uppercase form, but Caps Lock
  // (Shift + Caps cancels for letters) or some keyboard layout / IME states
  // can deliver the lowercase form — which caused Ctrl+Shift+S etc. to fall
  // through silently. The Ctrl+Alt+S handler above already guards both cases.
  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;

  // Help: Ctrl+? (Ctrl+Shift+/)
  if (key === '?' || (key === '/' && e.shiftKey)) {
    e.preventDefault();
    e.stopPropagation();
    openHelp();
    return;
  }

  // AI Chat: Ctrl+Shift+I — open + focus the input; if already focused inside
  // the panel, close it and return to the editor.
  if (key === 'I' && e.shiftKey) {
    e.preventDefault();
    e.stopPropagation();

    const panel = document.getElementById('ai-panel');
    const wasOpen = isAIPanelOpen();
    if (wasOpen && panel && panel.contains(document.activeElement)) {
      toggleAIPanel(); // close
      focusActiveEditor();
      return;
    }

    const view = currentView();
    let selectedText = '';
    if (view) {
      const { from, to } = view.state.selection.main;
      if (from !== to) selectedText = view.state.sliceDoc(from, to);
    }

    // Open if closed; if already open (focus elsewhere), keep it open and just
    // refresh the selection context before moving focus into it.
    if (!wasOpen) {
      toggleAIPanel(selectedText);
    } else if (selectedText) {
      updateSelectedContext(selectedText);
    }

    const aiPanelContent = document.getElementById('ai-panel-content');
    if (aiPanelContent && !aiPanelContent.hasChildNodes()) {
      initChatPanel(aiPanelContent, {
        getVaultPath: () => vaultPath,
        getActiveView: () => currentView(),
      }).then(() => {
        if (selectedText) updateSelectedContext(selectedText);
        const activeTab = getActiveTab();
        if (activeTab) updateDocContext(activeTab.path, activeTab.content);
        focusAIPanelInput();
      });
    } else {
      focusAIPanelInput();
    }
    return;
  }

  // AI Composer: Ctrl+Shift+C
  if (key === 'C' && e.shiftKey) {
    e.preventDefault();
    e.stopPropagation();
    const view = currentView();
    if (view) openComposerForView(view);
    return;
  }

  // Mode cycle: Ctrl+Shift+M
  if (key === 'M' && e.shiftKey) {
    e.preventDefault();
    e.stopPropagation();
    cycleMode();
    return;
  }

  // Go to path: Ctrl+Shift+P — open a file or folder by typing its path.
  // Works in every mode; bare Ctrl+P is left to the editor (emacs previous-line
  // / browser print).
  if (isGoToPathShortcut(e)) {
    e.preventDefault();
    e.stopPropagation();
    handleGoToPath();
    return;
  }

  switch (key) {
    // ── App actions on Ctrl+Shift+letter ───────────────────
    case 'S':
      // Ctrl+Shift+S = Save As (force the dialog). Plain save is Ctrl+S.
      e.preventDefault();
      e.stopPropagation();
      performSave({ forceDialog: true });
      return;
    case 'R':
      e.preventDefault();
      e.stopPropagation();
      manualReload();
      return;
    case 'W':
      e.preventDefault();
      e.stopPropagation();
      smartClose();
      return;
    case 'T':
      e.preventDefault();
      e.stopPropagation();
      openTab(null, '');
      return;
    case 'N':
      // Ctrl+Shift+N opens a new window (Tauri only); new tab is Ctrl+Shift+T.
      e.preventDefault();
      e.stopPropagation();
      if (isLocalTauri()) openInNewWindow(null);
      else openTab(null, '');
      return;
    case 'O':
      e.preventDefault();
      e.stopPropagation();
      handleOpenFolder();
      return;
    case 'E':
      e.preventDefault();
      e.stopPropagation();
      cycleSidebarFocus();
      return;
    case 'J':
      e.preventDefault();
      e.stopPropagation();
      setViewMode('editor');
      return;
    case 'K':
      e.preventDefault();
      e.stopPropagation();
      setViewMode('split');
      return;
    case 'L':
      e.preventDefault();
      e.stopPropagation();
      setViewMode('preview');
      return;
    case 'G':
      // Ctrl+Shift+G: insert a Markdown table via the grid-size popover.
      e.preventDefault();
      e.stopPropagation();
      openTableGridPicker();
      return;
    case 'B':
      // Ctrl+Shift+B: toggle the (normally hidden) menu bar.
      e.preventDefault();
      e.stopPropagation();
      toggleMenuBar();
      return;

    // ── Other shortcuts unchanged ──────────────────────────
    // (Ctrl+Tab / Ctrl+Shift+Tab handled up-front via tabActionForKey.)
    case '|':
    case 'D':
      if (e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        splitVertical();
      }
      return;
    case '\\':
    case 'H':
      if (e.shiftKey || e.key === '\\') {
        e.preventDefault();
        e.stopPropagation();
        splitHorizontal();
      }
      return;
    // App (UI) font size: Ctrl+Shift+= / Ctrl+Shift+- (the '+' / '_' keys with
    // Shift). Editor font size lives on bare Ctrl+= / Ctrl+- above.
    case '+':
    case '=':
      e.preventDefault();
      e.stopPropagation();
      setUiFontSize(getUiFontSize() + 1);
      return;
    case '_':
    case '-':
      e.preventDefault();
      e.stopPropagation();
      setUiFontSize(getUiFontSize() - 1);
      return;
    // Editor font size (Ctrl±) and pane focus (Ctrl+Arrows) and settings (Ctrl+,)
    // live on bare Ctrl above — not duplicated here.
  }
}

// ── Start ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
