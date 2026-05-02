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
  registerPanesModule,
} from './core/editor.js';
import { initPreview, renderMarkdown, syncPreviewToLine } from './core/preview.js';
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
  setCallbacks,
  createEditorInPane,
  getPaneCount,
} = panesModule;
import { initSidebar, loadDirectory, toggleSidebar, highlightFile, getShowAllFiles } from './core/sidebar.js';
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
import { reapplyMode, cycleMode } from './core/keymode.js';
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

// ── Initialization ─────────────────────────────────────────
async function init() {
  try {
    config = await backend.getConfig();
  } catch {
    config = {
      theme: 'dark',
      features: { ai_copilot: false, diff_highlight: true },
      font_size: 14,
      vim_mode: false,
    };
  }

  initTheme(config.theme || 'dark');
  if (config.font_size) setFontSize(config.font_size);

  // Init preview for the default pane
  const previewEl = document.querySelector('.pane[data-pane-id="default"] .preview-pane');
  if (previewEl) initPreview(previewEl);

  initPanes();

  // Wire up pane callbacks for editor changes, scroll sync, and selection changes
  setCallbacks({
    onChange: handlePaneContentChange,
    onScroll: handlePaneScroll,
    onSelectionChange: handleSelectionChange,
  });

  // Init sidebar
  const fileTree = document.getElementById('file-tree');
  if (fileTree) initSidebar(fileTree, handleFileSelect, {
    sort: config.sidebar_sort || 'name_asc',
    showAllFiles: config.sidebar_show_all_files || false,
    onSettingsChange: handleSidebarSettingsChange,
  });

  // Tab change callback
  setTabChangeCallback(handleTabChange);
  setTabPathChangeCallback(handleTabPathChange);
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
        const content = await backend.readFile(tabInfo.path);
        openTab(tabInfo.path, content);
      } catch {
        /* ignore */
      }
    }

    // Then ask about recovery if temp files exist
    if (recoverablePaths.length > 0) {
      const names = recoverablePaths.map((p) => p.split('/').pop()).join(', ');
      showRecoveryDialog(names, async () => {
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
      }, async () => {
        // Decline: delete temp files
        for (const path of recoverablePaths) {
          try {
            await backend.deleteTempFile(path);
          } catch {
            /* ignore */
          }
        }
      });
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

    // Open files dropped from file manager
    listen('tauri://drag-drop', async (event) => {
      const paths = event.payload?.paths;
      if (!paths || paths.length === 0) return;
      for (const filePath of paths.slice(0, 20)) {
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

  // Warn on window close if unsaved changes (Tauri)
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

function handlePaneContentChange(pane, newContent) {
  // Find the tab for the active pane
  const tab = getActiveTab();
  if (!tab) return;

  updateTabContent(tab.id, newContent);
  markDirty(tab.id);
  onContentChange(tab.path, newContent);

  // Update AI doc context with latest content
  updateDocContext(tab.path, newContent);

  if (viewMode === 'split' || viewMode === 'preview') {
    const basePath = tab.path ? tab.path.substring(0, tab.path.lastIndexOf('/')) : '';
    renderMarkdown(newContent, basePath, pane.previewContainer);
  }

  scheduleSessionSave();
}

function handlePaneScroll(pane, info) {
  if (viewMode !== 'split' || !pane.previewContainer) return;
  const { topLine, ratio } = info || {};
  if (typeof topLine === 'number') {
    syncPreviewToLine(pane.previewContainer, topLine);
  } else if (typeof ratio === 'number') {
    // Fallback to proportional sync if line info unavailable
    const maxScroll = pane.previewContainer.scrollHeight - pane.previewContainer.clientHeight;
    pane.previewContainer.scrollTop = maxScroll * ratio;
  }
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
    const content = await backend.readFile(path);
    openTab(path, content);
    highlightFile(path);
  } catch (e) {
    console.error('Failed to open file:', e);
  }
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
    const basePath = tab.path ? tab.path.substring(0, tab.path.lastIndexOf('/')) : '';
    renderMarkdown(tab.content, basePath, previewContainer);
  }

  if (tab.path) highlightFile(tab.path);

  // Update AI doc context
  updateDocContext(tab.path, tab.content);

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
        const basePath = path.substring(0, path.lastIndexOf('/'));
        renderMarkdown(content, basePath, p.previewContainer);
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
        const basePath = tab.path ? tab.path.substring(0, tab.path.lastIndexOf('/')) : '';
        renderMarkdown(tab.content, basePath, pane.previewContainer);
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
  } catch { /* ignore */ }
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
  } catch { /* ignore */ }

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
function handleGlobalKeys(e) {
  // Alt+key shortcuts (browser-friendly alternatives for Ctrl+N/T/W)
  if (e.altKey && !e.ctrlKey) {
    switch (e.key) {
      case 'n':
        e.preventDefault();
        openTab(null, '');
        return;
      case 't':
        e.preventDefault();
        openTab(null, '');
        return;
      case 'w': {
        e.preventDefault();
        const active = getActiveTab();
        if (active) closeTab(active.id);
        return;
      }
      case 'o':
        e.preventDefault();
        handleOpenFolder();
        return;
    }
    return;
  }

  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;

  // Let these keys pass through to CodeMirror (vim mode needs them)
  const passthroughKeys = ['u', 'd', 'f', 'b', 'c', 'v', 'x', 'z', 'a'];
  if (passthroughKeys.includes(e.key) && !e.shiftKey) return;

  // Help: Ctrl+? (Ctrl+Shift+/)
  if ((e.key === '?' || (e.key === '/' && e.shiftKey)) && !e.altKey) {
    e.preventDefault();
    e.stopPropagation();
    openHelp();
    return;
  }

  // Reload from disk: Ctrl+R (also blocks browser reload in browser mode)
  if ((e.key === 'r' || e.key === 'R') && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    e.stopPropagation();
    manualReload();
    return;
  }

  // AI Chat panel toggle: Ctrl+I
  if (e.key === 'i' && !e.shiftKey) {
    e.preventDefault();
    e.stopPropagation();
    // Get current selection before toggling
    const view = currentView();
    let selectedText = '';
    if (view) {
      const { from, to } = view.state.selection.main;
      if (from !== to) selectedText = view.state.sliceDoc(from, to);
    }
    toggleAIPanel(selectedText);
    // Lazy-init chat panel on first open
    const aiPanelContent = document.getElementById('ai-panel-content');
    if (aiPanelContent && !aiPanelContent.hasChildNodes()) {
      initChatPanel(aiPanelContent, {
        getVaultPath: () => vaultPath,
        getActiveView: () => currentView(),
      }).then(() => {
        // After init, set the selected context and doc context
        if (selectedText) {
          updateSelectedContext(selectedText);
        }
        const activeTab = getActiveTab();
        if (activeTab) {
          updateDocContext(activeTab.path, activeTab.content);
        }
      });
    }
    return;
  }

  // AI Composer: Ctrl+Shift+I
  if (e.key === 'I' && e.shiftKey) {
    e.preventDefault();
    e.stopPropagation();
    const view = currentView();
    if (view) openComposerForView(view);
    return;
  }

  // Vim toggle: Ctrl+Shift+M
  if (e.key === 'M' && e.shiftKey) {
    e.preventDefault();
    e.stopPropagation();
    cycleMode();
    return;
  }

  // Close pane: Ctrl+Shift+W
  if (e.key === 'W' && e.shiftKey && getPaneCount() > 1) {
    e.preventDefault();
    e.stopPropagation();
    closeActivePane();
    return;
  }

  // Save As: Ctrl+Shift+S
  if (e.key === 'S' && e.shiftKey) {
    e.preventDefault();
    e.stopPropagation();
    (async () => {
      const tab = getActiveTab();
      const view = currentView();
      if (!tab || !view) return;
      const content = getContent(view);
      try {
        let filePath;
        if (isLocalTauri()) {
          const { save } = await import('@tauri-apps/plugin-dialog');
          filePath = await save({
            filters: [{ name: 'Markdown', extensions: ['md'] }],
            defaultPath: tab.path || vaultPath || undefined,
          });
        } else {
          openSavePicker(tab.path || '', async (filePath) => {
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
        console.error('Save As failed:', err);
      }
    })();
    return;
  }

  switch (e.key) {
    case 'j':
      e.preventDefault();
      e.stopPropagation();
      setViewMode('editor');
      break;
    case 'k':
      e.preventDefault();
      e.stopPropagation();
      setViewMode('split');
      break;
    case 'l':
      e.preventDefault();
      e.stopPropagation();
      setViewMode('preview');
      break;
    case 't':
      e.preventDefault();
      e.stopPropagation();
      openTab(null, '');
      break;
    case 'Tab':
      e.preventDefault();
      e.stopPropagation();
      saveActivePaneTabState();
      e.shiftKey ? prevTab() : nextTab();
      break;
    case 'w': {
      e.preventDefault();
      e.stopPropagation();
      // Ctrl+Shift+W closes the active split pane; Ctrl+W closes the tab
      if (e.shiftKey && getPaneCount() > 1) {
        closeActivePane();
      } else {
        const active = getActiveTab();
        if (active) closeTab(active.id);
      }
      break;
    }
    case 'e':
      e.preventDefault();
      e.stopPropagation();
      toggleSidebar();
      break;
    case 's':
      e.preventDefault();
      e.stopPropagation();
      (async () => {
        const tab = getActiveTab();
        const view = currentView();
        if (!tab || !view) return;
        const content = getContent(view);
        if (tab.path) {
          const ok = await triggerSave(tab.path, content);
          if (ok) {
            markClean(tab.id);
            refreshSidebar();
          }
        } else {
          // Save As dialog for untitled tabs
          try {
            let filePath;
            if (isLocalTauri()) {
              const { save } = await import('@tauri-apps/plugin-dialog');
              filePath = await save({
                filters: [{ name: 'Markdown', extensions: ['md'] }],
                defaultPath: vaultPath || undefined,
              });
            } else {
              openSavePicker(vaultPath || '', async (filePath) => {
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
            console.error('Save As failed:', err);
          }
        }
      })();
      break;
    case 'o':
      e.preventDefault();
      e.stopPropagation();
      handleOpenFolder();
      break;
    case 'n':
      e.preventDefault();
      e.stopPropagation();
      openTab(null, '');
      break;
    // Pane split
    case '|':  // Ctrl+Shift+\
    case 'D':  // Ctrl+Shift+D (alternative)
      if (e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        splitVertical();
      }
      break;
    case '\\': // Ctrl+\
    case 'H':  // Ctrl+Shift+H (alternative)
      if (e.shiftKey || e.key === '\\') {
        e.preventDefault();
        e.stopPropagation();
        splitHorizontal();
      }
      break;
    case '-':
      e.preventDefault();
      e.stopPropagation();
      setFontSize(Math.max(10, getFontSize() - 1));
      break;
    case '=':
    case '+':
      e.preventDefault();
      e.stopPropagation();
      setFontSize(Math.min(32, getFontSize() + 1));
      break;
    case 'ArrowLeft':
      e.preventDefault();
      e.stopPropagation();
      focusPane('left');
      break;
    case 'ArrowRight':
      e.preventDefault();
      e.stopPropagation();
      focusPane('right');
      break;
    case 'ArrowUp':
      e.preventDefault();
      e.stopPropagation();
      focusPane('up');
      break;
    case 'ArrowDown':
      e.preventDefault();
      e.stopPropagation();
      focusPane('down');
      break;
    case ',':
      e.preventDefault();
      e.stopPropagation();
      openSettings();
      break;
    // Ctrl+Shift+V and Ctrl+? are handled above the switch
  }
}

// ── Start ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
