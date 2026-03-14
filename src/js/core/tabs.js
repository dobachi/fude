// tabs.js - Tab management, one EditorView at a time

let tabs = [];
let activeTabId = null;
let nextTabId = 1;
let onTabChange = null;

export function setTabChangeCallback(callback) {
  onTabChange = callback;
}

function generateTabId() {
  return `tab-${nextTabId++}`;
}

function getFilename(path) {
  if (!path) return 'Untitled';
  return path.split('/').pop().split('\\').pop();
}

export function openTab(path, content = '') {
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
  };

  tabs.push(tab);
  activeTabId = tab.id;

  renderTabBar();
  if (onTabChange) onTabChange(tab);

  return tab;
}

export function closeTab(id) {
  const index = tabs.findIndex((t) => t.id === id);
  if (index === -1) return;

  tabs.splice(index, 1);

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

function renderTabBar() {
  const tabBar = document.getElementById('tab-bar');
  if (!tabBar) return;

  tabBar.innerHTML = '';

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
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(tab.id);
    });
    el.appendChild(closeBtn);

    el.addEventListener('click', () => switchTab(tab.id));
    el.addEventListener('mousedown', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        closeTab(tab.id);
      }
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
    }))
    .filter((t) => t.path);
}

export function getActiveTabIndex() {
  return tabs.findIndex((t) => t.id === activeTabId);
}
