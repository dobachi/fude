// app.js - Main orchestrator
import * as backend from './backend.js';
import {
  createEditor,
  getContent,
  getCursor,
  getScroll,
  setCursor,
  setScroll,
  setFontSize,
  getFontSize,
  setContent,
} from './core/editor.js';
import { initPreview, renderMarkdown } from './core/preview.js';
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
  getTabsForSession,
  getActiveTabIndex,
  getAllTabs,
} from './core/tabs.js';
import {
  initPanes,
  splitVertical,
  splitHorizontal,
  focusPane,
  getActivePaneEditorContainer,
  getActivePanePreviewContainer,
} from './core/panes.js';
import { initSidebar, loadDirectory, toggleSidebar, highlightFile } from './core/sidebar.js';
import { scheduleSave, restoreSession } from './core/session.js';
import { initTheme } from './core/theme.js';
import { onContentChange, triggerSave, checkRecovery } from './core/autosave.js';
import { reapplyMode, cycleMode } from './core/keymode.js';
import { openSettings } from './settings.js';
import { openHelp } from './help.js';
import { checkForUpdates } from './core/updater.js';

let currentView = null;
let viewMode = 'split';
let vaultPath = '';
let config = {};

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

  // Init preview
  const previewEl = document.querySelector('.pane[data-pane-id="default"] .preview-pane');
  if (previewEl) initPreview(previewEl);

  initPanes();

  // Init sidebar
  const fileTree = document.getElementById('file-tree');
  if (fileTree) initSidebar(fileTree, handleFileSelect);

  // Tab change callback
  setTabChangeCallback(handleTabChange);

  // Global keyboard shortcuts - capture at window level to override browser defaults
  window.addEventListener('keydown', handleGlobalKeys, true);

  // Ctrl+mouse wheel zoom
  window.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        if (e.deltaY < 0) {
          setFontSize(Math.min(32, getFontSize() + 1));
        } else {
          setFontSize(Math.max(10, getFontSize() - 1));
        }
      }
    },
    { passive: false },
  );

  // Sidebar toggle button
  const sidebarToggle = document.getElementById('sidebar-toggle');
  if (sidebarToggle) sidebarToggle.addEventListener('click', toggleSidebar);

  // Try restore session
  const session = await restoreSession();
  if (session && session.open_tabs && session.open_tabs.length > 0) {
    vaultPath = session.vault_path || '';
    viewMode = session.view_mode || 'split';
    applyViewMode();

    if (vaultPath) {
      try {
        const tree = await backend.readDirTree(vaultPath);
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
                const editorContainer = getActivePaneEditorContainer();
                if (editorContainer && currentView) {
                  setContent(currentView, tempContent);
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
    openTab(
      null,
      '# Welcome to Fude\n\nOpen a folder with **Ctrl+O** or create a new file with **Ctrl+N**.\n',
    );
    applyViewMode();
  }

  // Listen for CLI args event from Tauri
  if (window.__TAURI__) {
    const { listen } = await import('@tauri-apps/api/event');
    listen('cli-args', async (event) => {
      const path = event.payload?.path;
      if (path) await openPath(path);
    });
  }

  // Auto-focus editor when window gains focus
  window.addEventListener('focus', () => {
    if (currentView) currentView.focus();
  });

  // Warn on window close if unsaved changes (Tauri)
  if (window.__TAURI__) {
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

  // Check for updates (non-blocking)
  checkForUpdates();
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
    const tree = await backend.readDirTree(path);
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
  const editorContainer = getActivePaneEditorContainer();
  const previewContainer = getActivePanePreviewContainer();

  if (!tab) {
    if (editorContainer) {
      editorContainer.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-title">Fude</div>
          <div class="empty-state-hint"><kbd>Ctrl+O</kbd> Open folder &nbsp; <kbd>Ctrl+N</kbd> New file</div>
        </div>`;
    }
    if (previewContainer) previewContainer.innerHTML = '';
    return;
  }

  // Save previous tab state
  if (currentView) {
    const prevTab = getActiveTab();
    if (prevTab) {
      updateTabCursor(prevTab.id, getCursor(currentView));
      updateTabScroll(prevTab.id, getScroll(currentView));
    }
  }

  currentView = createEditor(
    editorContainer,
    tab.content,
    (newContent) => {
      updateTabContent(tab.id, newContent);
      markDirty(tab.id);
      onContentChange(tab.path, newContent);

      if (viewMode === 'split' || viewMode === 'preview') {
        const basePath = tab.path ? tab.path.substring(0, tab.path.lastIndexOf('/')) : '';
        renderMarkdown(newContent, basePath);
      }

      scheduleSessionSave();
    },
    (scrollRatio) => {
      if (viewMode === 'split' && previewContainer) {
        const maxScroll = previewContainer.scrollHeight - previewContainer.clientHeight;
        previewContainer.scrollTop = maxScroll * scrollRatio;
      }
    },
  );

  // Apply vim mode
  reapplyMode();

  // Restore cursor and scroll
  if (tab.cursor) setCursor(currentView, tab.cursor.from || 0, tab.cursor.to || 0);
  if (tab.scroll) setScroll(currentView, tab.scroll);

  // Render preview
  if (viewMode === 'split' || viewMode === 'preview') {
    const basePath = tab.path ? tab.path.substring(0, tab.path.lastIndexOf('/')) : '';
    renderMarkdown(tab.content, basePath);
  }

  if (tab.path) highlightFile(tab.path);

  // Focus editor after tab switch
  if (currentView) currentView.focus();

  // Save session on tab change
  scheduleSessionSave();
}

// ── View mode ──────────────────────────────────────────────
function applyViewMode() {
  const pane = document.querySelector('.pane[data-pane-id="default"]');
  if (!pane) return;

  pane.classList.remove('view-split', 'view-preview');
  if (viewMode === 'split') pane.classList.add('view-split');
  else if (viewMode === 'preview') pane.classList.add('view-preview');

  if (viewMode === 'split' || viewMode === 'preview') {
    const tab = getActiveTab();
    if (tab) {
      const basePath = tab.path ? tab.path.substring(0, tab.path.lastIndexOf('/')) : '';
      renderMarkdown(tab.content, basePath);
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
    const tree = await backend.readDirTree(vaultPath);
    loadDirectory(tree);
  } catch { /* ignore */ }
}

// ── Open folder dialog ─────────────────────────────────────
async function handleOpenFolder() {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const folder = await open({ directory: true, multiple: false });
    if (folder) {
      vaultPath = folder;
      const tree = await backend.readDirTree(folder);
      loadDirectory(tree);
      scheduleSessionSave();
    }
  } catch (e) {
    console.error('Failed to open folder:', e);
  }
}

// ── Global keyboard shortcuts ──────────────────────────────
function handleGlobalKeys(e) {
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

  // Vim toggle: Ctrl+Shift+M
  if (e.key === 'M' && e.shiftKey) {
    e.preventDefault();
    e.stopPropagation();
    cycleMode();
    return;
  }

  // Save As: Ctrl+Shift+S
  if (e.key === 'S' && e.shiftKey) {
    e.preventDefault();
    e.stopPropagation();
    (async () => {
      const tab = getActiveTab();
      if (!tab || !currentView) return;
      const content = getContent(currentView);
      try {
        const { save } = await import('@tauri-apps/plugin-dialog');
        const filePath = await save({
          filters: [{ name: 'Markdown', extensions: ['md'] }],
          defaultPath: tab.path || vaultPath || undefined,
        });
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
      e.shiftKey ? prevTab() : nextTab();
      break;
    case 'w': {
      e.preventDefault();
      e.stopPropagation();
      const active = getActiveTab();
      if (active) closeTab(active.id);
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
        if (!tab || !currentView) return;
        const content = getContent(currentView);
        if (tab.path) {
          const ok = await triggerSave(tab.path, content);
          if (ok) {
            markClean(tab.id);
            refreshSidebar();
          }
        } else {
          // Save As dialog for untitled tabs
          try {
            const { save } = await import('@tauri-apps/plugin-dialog');
            const filePath = await save({
              filters: [{ name: 'Markdown', extensions: ['md'] }],
              defaultPath: vaultPath || undefined,
            });
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
    // Pane split disabled until fully implemented
    // case '|':
    //   e.preventDefault();
    //   e.stopPropagation();
    //   splitVertical();
    //   break;
    // case '\\':
    //   e.preventDefault();
    //   e.stopPropagation();
    //   splitHorizontal();
    //   break;
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
