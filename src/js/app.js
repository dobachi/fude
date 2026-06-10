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
  registerPanesModule,
  registerImagePasteHandler,
  registerSaveHandler,
} from './core/editor.js';
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
import { promptDialog, confirmDialog } from './core/dialog.js';
import {
  initPreview,
  syncPreviewToLine,
  getLineFromPreview,
  setPlantumlEnabled,
  renderPreview,
} from './core/preview.js';
import {
  openTab,
  closeTab,
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
} from './core/tabs.js';
import * as panesModule from './core/panes.js';
const {
  initPanes,
  splitVertical,
  splitHorizontal,
  closeActivePane,
  focusPane,
  getActivePane,
  getActivePaneView,
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
  hideSidebar,
  focusFiler,
  nextSidebarFocusAction,
} from './core/sidebar.js';
import { scheduleSave, restoreSession } from './core/session.js';
import { initTheme } from './core/theme.js';
import { onContentChange, triggerSave, checkRecovery } from './core/autosave.js';
import {
  initFileWatcher,
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

let viewMode = 'split';
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
 * Ctrl+Shift+E focus-cycle across the sidebar:
 * hidden → filer → outline → hide+editor. The decision is computed by the pure
 * nextSidebarFocusAction(); here we just execute the chosen action.
 */
function cycleSidebarFocus() {
  const active = document.activeElement;
  const fileTree = document.getElementById('file-tree');
  const outline = document.getElementById('outline-list');
  const action = nextSidebarFocusAction({
    visible: isSidebarVisible(),
    focusInFiler: !!(fileTree && fileTree.contains(active)),
    focusInOutline: !!(outline && outline.contains(active)),
  });
  switch (action) {
    case 'show-filer':
      showSidebar();
      focusFiler();
      break;
    case 'focus-outline':
      focusOutline();
      break;
    case 'hide-return':
      hideSidebar();
      focusActiveEditor();
      break;
    case 'focus-filer':
    default:
      focusFiler();
      break;
  }
}

/** Re-render the preview in every pane (used after a live config change). */
function rerenderPreviews() {
  if (viewMode !== 'split' && viewMode !== 'preview') return;
  for (const p of panesModule.getAllPanes()) {
    if (!p.previewContainer) continue;
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
      key_mode: 'normal',
    };
  }

  initTheme(config.theme || 'dark');
  setPlantumlEnabled(config.features?.plantuml_preview);

  // Live-apply config changes saved from the Settings panel.
  window.addEventListener('fude:config-saved', (e) => {
    const saved = e.detail || {};
    config = saved;
    setPlantumlEnabled(saved.features?.plantuml_preview);
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
      await getCurrentWindow().setTitle(`Fude v${ver}`);
    } catch (e) {
      console.warn('Could not read/set app version:', e);
      setAppVersion('?');
    }
  }

  // Restore the keymode (normal / vim / emacs). Backward compat: legacy `vim_mode: true`.
  await initKeymode(config.key_mode || (config.vim_mode ? 'vim' : 'normal'));
  if (config.font_size) setFontSize(config.font_size);

  // Init preview for the default pane
  const previewEl = document.querySelector('.pane[data-pane-id="default"] .preview-pane');
  if (previewEl) initPreview(previewEl);

  initPanes();

  // Wire up pane callbacks for editor changes, scroll sync, and selection changes
  setCallbacks({
    onChange: handlePaneContentChange,
    onScroll: handlePaneScroll,
    onPreviewScroll: handlePreviewScroll,
    onSelectionChange: handleSelectionChange,
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
        const view = currentView();
        if (!view) return;
        // Jumping is a user-initiated move; skip the editor→preview lockout
        // that typing installs, but suppress the bounce-back from the editor
        // scroll event we are about to dispatch.
        recordScrollSync('editor');
        jumpToLine(view, line);
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

  // Global keyboard shortcuts - capture at window level to override browser defaults
  window.addEventListener('keydown', handleGlobalKeys, true);

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

  // Try restore session
  const session = await restoreSession();
  if (session && session.open_tabs && session.open_tabs.length > 0) {
    vaultPath = session.vault_path || '';
    viewMode = session.view_mode || 'split';
    applyViewMode();

    if (vaultPath) {
      try {
        const tree = await backend.readDirTree(vaultPath, getShowAllFiles());
        loadDirectory(tree);
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
        if (isImagePath(tabInfo.path)) {
          openTab(tabInfo.path, '', { kind: 'image' });
          continue;
        }
        const content = await backend.readFile(tabInfo.path);
        openTab(tabInfo.path, content);
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
  } else {
    // Check if server specified an initial directory
    if (!isLocalTauri()) {
      try {
        const openDir = await backend.getOpenDir();
        if (openDir) {
          vaultPath = openDir;
          const tree = await backend.readDirTree(openDir, getShowAllFiles());
          loadDirectory(tree);
        }
      } catch {
        /* ignore */
      }
    }
    openTab(
      null,
      '# Welcome to Fude\n\nOpen a folder with **Ctrl+O** or create a new file with **Ctrl+N**.\n',
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

  if (viewMode === 'split' || viewMode === 'preview') {
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

  if (viewMode !== 'split' || !pane.previewContainer) return;
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
  if (viewMode !== 'split' || !pane.editorView) return;
  if (!shouldHandleScroll('preview')) return;
  const line = getLineFromPreview(pane.previewContainer);
  if (line === null) return;
  recordScrollSync('preview');
  scrollEditorToLine(pane.editorView, line);
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
      if (viewMode === 'preview') setViewMode('split');
      return;
    }
    const content = await backend.readFile(path);
    openTab(path, content);
    highlightFile(path);
  } catch (e) {
    console.error('Failed to open file:', e);
    showToast(`ファイルを開けませんでした: ${e?.message || e}`, { type: 'error', duration: 6000 });
  }
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

function handleFileContextMenu(entry, x, y) {
  const items = [];
  if (!entry.isDir) items.push({ label: '開く', action: () => handleFileSelect(entry.path) });
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
  const items = [
    { label: '閉じる', action: () => closeTab(tabId) },
    { label: '他のタブを閉じる', action: () => closeOtherTabs(tabId) },
    { label: '右側のタブを閉じる', action: () => closeTabsToRight(tabId) },
    { label: 'すべて閉じる', action: () => closeAllTabs() },
  ];
  if (tab.path) {
    items.push(
      { separator: true },
      { label: 'パスをコピー', action: () => copyText(tab.path) },
      { label: 'ファイル名をコピー', action: () => copyText(getFilename(tab.path)) },
      { separator: true },
      { label: 'ファイルマネージャで表示', action: () => revealInFileManager(tab.path) },
    );
  }
  showMenu(x, y, items);
}

async function openPath(path) {
  try {
    const tree = await backend.readDirTree(path, getShowAllFiles());
    vaultPath = path;
    loadDirectory(tree);
  } catch {
    try {
      const content = await backend.readFile(path);
      openTab(path, content);
    } catch (e) {
      console.error('Failed to open path:', e);
    }
  }
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
          <div class="empty-state-hint"><kbd>Ctrl+O</kbd> Open folder &nbsp; <kbd>Ctrl+N</kbd> New file</div>
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
    scheduleSessionSave();
    return;
  }

  // Create a new editor in the active pane
  const view = createEditorInPane(pane, tab.content);

  // Update pane file tracking
  pane.filePath = tab.path;
  pane.content = tab.content;
  pane.dirty = tab.dirty;

  // Apply vim mode
  reapplyMode();

  // Restore cursor and scroll
  if (tab.cursor) setCursor(view, tab.cursor.from || 0, tab.cursor.to || 0);
  if (tab.scroll) setScroll(view, tab.scroll);

  // Render preview
  if (viewMode === 'split' || viewMode === 'preview') {
    const basePath = dirnameOf(tab.path);
    renderPreview(tab.content, basePath, previewContainer, tab.path);
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
      if ((viewMode === 'split' || viewMode === 'preview') && p.previewContainer) {
        const basePath = dirnameOf(path);
        renderPreview(content, basePath, p.previewContainer, path);
      }
    }
  }
  updateTabContent(tabId, content);
  markClean(tabId);
  updateDocContext(path, content);
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
function applyViewMode() {
  // Apply to all panes
  const allPanes = panesModule.getAllPanes();
  for (const p of allPanes) {
    p.element.classList.remove('view-split', 'view-preview');
    if (viewMode === 'split') p.element.classList.add('view-split');
    else if (viewMode === 'preview') p.element.classList.add('view-preview');
  }

  if (viewMode === 'split' || viewMode === 'preview') {
    const tab = getActiveTab();
    if (tab) {
      const pane = getActivePane();
      if (pane) {
        const basePath = dirnameOf(tab.path);
        renderPreview(tab.content, basePath, pane.previewContainer, tab.path);
      }
    }
  }
}

function setViewMode(mode) {
  viewMode = mode;
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

  overlay.querySelector('.btn-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('.btn-confirm').addEventListener('click', () => {
    overlay.remove();
    onConfirm();
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
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

  overlay.querySelector('.btn-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('.btn-confirm').addEventListener('click', () => {
    overlay.remove();
    onConfirm();
  });
}

// ── Session save ───────────────────────────────────────────
function scheduleSessionSave() {
  scheduleSave(() => ({
    open_tabs: getTabsForSession(),
    active_tab: getActiveTabIndex(),
    vault_path: vaultPath || null,
    view_mode: viewMode,
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
async function handleOpenFolder() {
  try {
    if (isLocalTauri()) {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const folder = await open({ directory: true, multiple: false });
      if (folder) {
        vaultPath = folder;
        const tree = await backend.readDirTree(folder, getShowAllFiles());
        loadDirectory(tree);
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

  // Quick path: existing path + not forcing dialog → just write
  if (tab.path && !forceDialog) {
    const ok = await triggerSave(tab.path, content);
    if (ok) {
      markClean(tab.id);
      refreshSidebar();
    }
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
        refreshSidebar();
      }
    }
  } catch (err) {
    console.error('Save failed:', err);
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

function handleGlobalKeys(e) {
  // Alt+key shortcuts (browser-friendly fallbacks; harmless in Tauri)
  if (e.altKey && !e.ctrlKey) {
    // In Emacs mode, let Alt-* fall through to CodeMirror (M-b/f/v/d/w etc.)
    if (getMode() === 'emacs') return;
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
      case 'Tab':
        e.preventDefault();
        e.stopPropagation();
        saveActivePaneTabState();
        nextTab();
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
    case 'N':
      e.preventDefault();
      e.stopPropagation();
      openTab(null, '');
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

    // ── Other shortcuts unchanged ──────────────────────────
    case 'Tab':
      e.preventDefault();
      e.stopPropagation();
      saveActivePaneTabState();
      e.shiftKey ? prevTab() : nextTab();
      return;
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
    // Font size (Ctrl±) and pane focus (Ctrl+Arrows) and settings (Ctrl+,)
    // live on bare Ctrl above — not duplicated here.
  }
}

// ── Start ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
