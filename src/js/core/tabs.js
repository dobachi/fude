// tabs.js - Tab management, one EditorView at a time
import * as backend from '../backend.js';
import { clearPanesWithFile } from './panes.js';

function showConfirmDialog(message, onConfirm) {
  const overlay = document.createElement('div');
  overlay.className = 'settings-overlay';
  overlay.innerHTML = `
    <div class="settings-panel" style="width:360px">
      <div class="settings-body" style="padding:20px">
        <p style="margin-bottom:16px;color:var(--fg-primary)">${message}</p>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button class="btn-cancel" style="padding:6px 16px;background:var(--bg-tertiary);color:var(--fg-primary);border:1px solid var(--border);border-radius:4px;cursor:pointer">キャンセル</button>
          <button class="btn-confirm" style="padding:6px 16px;background:var(--fg-accent);color:#fff;border:none;border-radius:4px;cursor:pointer">閉じる</button>
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
  // Keyboard support: Enter confirms, Escape cancels. Capture phase so it works
  // regardless of which element holds focus. Focus the confirm button so the
  // dialog is operable by keyboard (Tab between buttons, Space/Enter to activate).
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

let tabs = [];
let activeTabId = null;
let nextTabId = 1;
let onTabChange = null;
let onTabPathChange = null;
let onTabContextMenu = null;

export function setTabContextMenuCallback(callback) {
  onTabContextMenu = callback;
}

export function setTabChangeCallback(callback) {
  onTabChange = callback;
}

/**
 * Notified when a tab gains, loses, or changes its file path.
 * @param {(args: { tabId: string, oldPath: string|null, newPath: string|null }) => void} callback
 */
export function setTabPathChangeCallback(callback) {
  onTabPathChange = callback;
}

function generateTabId() {
  return `tab-${nextTabId++}`;
}

function getFilename(path) {
  if (!path) return 'Untitled';
  return path.split('/').pop().split('\\').pop();
}

export function openTab(path, content = '', opts = {}) {
  // Check if file already open
  if (path) {
    const existing = tabs.find((t) => t.path === path);
    if (existing) {
      switchTab(existing.id);
      return existing;
    }
  }

  const tab = {
    id: generateTabId(),
    path: path || null,
    name: getFilename(path),
    content,
    dirty: false,
    cursor: { from: 0, to: 0 },
    scroll: { top: 0, left: 0 },
    // 'text' (editable) or 'image' (read-only viewer).
    kind: opts.kind || 'text',
    // Per-tab view mode: 'split' | 'editor' | 'preview'.
    viewMode: opts.viewMode || 'split',
  };

  tabs.push(tab);
  activeTabId = tab.id;

  renderTabBar();
  if (onTabChange) onTabChange(tab);
  if (onTabPathChange && tab.path) {
    onTabPathChange({ tabId: tab.id, oldPath: null, newPath: tab.path });
  }

  return tab;
}

export function closeTab(id) {
  const index = tabs.findIndex((t) => t.id === id);
  if (index === -1) return;

  const tab = tabs[index];
  if (tab.dirty) {
    const name = tab.path ? tab.path.split('/').pop() : 'Untitled';
    showConfirmDialog(`"${name}" は未保存です。閉じますか？`, () => {
      forceCloseTab(id);
    });
    return;
  }

  forceCloseTab(id);
}

/** Close every tab except `id`. */
export function closeOtherTabs(id) {
  for (const tid of tabs.filter((t) => t.id !== id).map((t) => t.id)) closeTab(tid);
}

/** Close all tabs to the right of `id`. */
export function closeTabsToRight(id) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  for (const tid of tabs.slice(idx + 1).map((t) => t.id)) closeTab(tid);
}

/** Close all tabs. */
export function closeAllTabs() {
  for (const tid of tabs.map((t) => t.id)) closeTab(tid);
}

function forceCloseTab(id) {
  const index = tabs.findIndex((t) => t.id === id);
  if (index === -1) return;

  // Delete temp file and clear panes showing this file
  const tab = tabs[index];
  if (tab.path) {
    backend.deleteTempFile(tab.path).catch(() => {});
    clearPanesWithFile(tab.path);
  }

  tabs.splice(index, 1);

  // Notify after splice so listeners querying getAllTabs() don't see the closed tab
  if (tab.path && onTabPathChange) {
    onTabPathChange({ tabId: tab.id, oldPath: tab.path, newPath: null });
  }

  if (activeTabId === id) {
    if (tabs.length > 0) {
      const newIndex = Math.min(index, tabs.length - 1);
      activeTabId = tabs[newIndex].id;
      if (onTabChange) onTabChange(tabs[newIndex]);
    } else {
      activeTabId = null;
      if (onTabChange) onTabChange(null);
    }
  }

  renderTabBar();
}

export function switchTab(id) {
  if (activeTabId === id) return;
  activeTabId = id;
  const tab = tabs.find((t) => t.id === id);
  renderTabBar();
  if (onTabChange && tab) onTabChange(tab);
}

export function nextTab() {
  if (tabs.length <= 1) return;
  const index = tabs.findIndex((t) => t.id === activeTabId);
  const next = (index + 1) % tabs.length;
  switchTab(tabs[next].id);
}

export function prevTab() {
  if (tabs.length <= 1) return;
  const index = tabs.findIndex((t) => t.id === activeTabId);
  const prev = (index - 1 + tabs.length) % tabs.length;
  switchTab(tabs[prev].id);
}

export function getActiveTab() {
  return tabs.find((t) => t.id === activeTabId) || null;
}

export function getAllTabs() {
  return [...tabs];
}

export function markDirty(id) {
  const tabId = id || activeTabId;
  const tab = tabs.find((t) => t.id === tabId);
  if (tab && !tab.dirty) {
    tab.dirty = true;
    renderTabBar();
  }
}

export function markClean(id) {
  const tabId = id || activeTabId;
  const tab = tabs.find((t) => t.id === tabId);
  if (tab && tab.dirty) {
    tab.dirty = false;
    renderTabBar();
  }
}

export function updateTabPath(id, path) {
  const tab = tabs.find((t) => t.id === id);
  if (tab) {
    const oldPath = tab.path;
    tab.path = path;
    tab.name = getFilename(path);
    renderTabBar();
    if (onTabPathChange && oldPath !== path) {
      onTabPathChange({ tabId: tab.id, oldPath, newPath: path });
    }
  }
}

export function updateTabContent(id, content) {
  const tab = tabs.find((t) => t.id === id);
  if (tab) tab.content = content;
}

export function updateTabCursor(id, cursor) {
  const tab = tabs.find((t) => t.id === id);
  if (tab) tab.cursor = cursor;
}

export function updateTabScroll(id, scroll) {
  const tab = tabs.find((t) => t.id === id);
  if (tab) tab.scroll = scroll;
}

/** Set a tab's view mode ('split' | 'editor' | 'preview'). */
export function setTabViewMode(id, mode) {
  const tab = tabs.find((t) => t.id === id);
  if (tab) tab.viewMode = mode;
}

/** Get a tab's view mode, falling back to 'split'. */
export function getTabViewMode(id) {
  const tab = tabs.find((t) => t.id === id);
  return tab ? tab.viewMode || 'split' : 'split';
}

function renderTabBar() {
  const tabBar = document.getElementById('tab-bar');
  if (!tabBar) return;

  // Remove only tab elements, preserve the sidebar-open button
  tabBar.querySelectorAll('.tab').forEach((el) => el.remove());

  tabs.forEach((tab) => {
    const el = document.createElement('div');
    el.className = `tab${tab.id === activeTabId ? ' active' : ''}${tab.dirty ? ' dirty' : ''}`;
    el.dataset.tabId = tab.id;

    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = getFilename(tab.path);
    el.appendChild(name);

    const dot = document.createElement('span');
    dot.className = 'tab-dirty';
    el.appendChild(dot);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'tab-close';
    closeBtn.textContent = '\u00d7';
    closeBtn.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();
    });
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Use setTimeout to let the click event fully complete before showing confirm
      setTimeout(() => closeTab(tab.id), 0);
    });
    el.appendChild(closeBtn);

    el.addEventListener('click', () => switchTab(tab.id));
    el.addEventListener('mousedown', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        e.stopPropagation();
        setTimeout(() => closeTab(tab.id), 0);
      }
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (onTabContextMenu) onTabContextMenu(tab.id, e.clientX, e.clientY);
    });

    tabBar.appendChild(el);
  });
}

export function getTabsForSession() {
  return tabs
    .map((t) => ({
      path: t.path,
      cursor_line: 0,
      cursor_col: 0,
      scroll_top: t.scroll ? t.scroll.top : 0,
      view_mode: t.viewMode || 'split',
    }))
    .filter((t) => t.path);
}

export function getActiveTabIndex() {
  return tabs.findIndex((t) => t.id === activeTabId);
}
