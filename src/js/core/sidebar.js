// sidebar.js - Directory tree sidebar

import { createListKeyHandler } from './list-nav.js';

let fileTreeContainer = null;
let onFileSelect = null;
let activeFilePath = null;
let currentEntries = [];
// Directory paths the user has expanded. Persisted across re-renders so an
// external-change refresh (or sort change) doesn't collapse the whole tree.
const openDirs = new Set();
let currentSort = 'name_asc';
let showAllFiles = false;
let onSettingsChange = null;
let onContextMenu = null;

const SORT_OPTIONS = {
  name_asc: { key: 'name', order: 'asc' },
  name_desc: { key: 'name', order: 'desc' },
  modified_desc: { key: 'modified', order: 'desc' },
  modified_asc: { key: 'modified', order: 'asc' },
  created_desc: { key: 'created', order: 'desc' },
  created_asc: { key: 'created', order: 'asc' },
  size_desc: { key: 'size', order: 'desc' },
  size_asc: { key: 'size', order: 'asc' },
};

export function initSidebar(container, fileSelectCallback, opts) {
  fileTreeContainer = container;
  onFileSelect = fileSelectCallback;

  if (opts) {
    if (opts.sort) currentSort = opts.sort;
    if (opts.showAllFiles) showAllFiles = opts.showAllFiles;
    if (opts.onSettingsChange) onSettingsChange = opts.onSettingsChange;
    if (opts.onContextMenu) onContextMenu = opts.onContextMenu;
  }

  if (container) {
    container.addEventListener(
      'keydown',
      createListKeyHandler(container, '.tree-item-label', { extra: treeNavExtra }),
    );
  }

  initPopover();
}

/**
 * Tree-specific keys for the filer: Right expands a collapsed directory, Left
 * collapses an open directory or jumps to the parent directory. Returns true
 * when the event is handled.
 */
function treeNavExtra(e, focused) {
  if (!focused || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return false;
  const item = focused.closest('.tree-item');
  const isDir = !!item && item.classList.contains('tree-dir');

  if (e.key === 'ArrowRight') {
    if (isDir && !item.classList.contains('open')) {
      e.preventDefault();
      focused.click(); // expand
      return true;
    }
    return false;
  }

  // ArrowLeft
  if (isDir && item.classList.contains('open')) {
    e.preventDefault();
    focused.click(); // collapse
    return true;
  }
  const parentDir = item && item.parentElement ? item.parentElement.closest('.tree-dir') : null;
  if (parentDir) {
    const parentLabel = parentDir.querySelector(':scope > .tree-item-label');
    if (parentLabel) {
      e.preventDefault();
      parentLabel.focus();
      return true;
    }
  }
  return false;
}

function initPopover() {
  const btn = document.getElementById('sidebar-settings-btn');
  const popover = document.getElementById('sidebar-settings-popover');
  if (!btn || !popover) return;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    popover.classList.toggle('hidden');
  });

  // Close on outside click
  document.addEventListener('click', (e) => {
    if (!popover.contains(e.target) && e.target !== btn) {
      popover.classList.add('hidden');
    }
  });

  // Set initial state
  const radio = popover.querySelector(`input[name="sidebar-sort"][value="${currentSort}"]`);
  if (radio) radio.checked = true;

  const allFilesCheck = document.getElementById('sidebar-show-all');
  if (allFilesCheck) allFilesCheck.checked = showAllFiles;

  // Sort change
  popover.querySelectorAll('input[name="sidebar-sort"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      currentSort = e.target.value;
      renderSorted();
      saveSettings();
    });
  });

  // Show all files toggle
  if (allFilesCheck) {
    allFilesCheck.addEventListener('change', (e) => {
      showAllFiles = e.target.checked;
      saveSettings();
    });
  }
}

function saveSettings() {
  if (onSettingsChange) {
    onSettingsChange({ sort: currentSort, showAllFiles });
  }
}

function sortEntries(entries) {
  const opt = SORT_OPTIONS[currentSort];
  if (!opt) return entries;

  const sorted = [...entries].sort((a, b) => {
    // Directories always first
    if (a.is_dir && !b.is_dir) return -1;
    if (!a.is_dir && b.is_dir) return 1;

    let result;
    if (opt.key === 'name') {
      result = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    } else {
      const aVal = a[opt.key] ?? 0;
      const bVal = b[opt.key] ?? 0;
      result = aVal - bVal;
    }

    return opt.order === 'desc' ? -result : result;
  });

  // Recursively sort children
  return sorted.map((entry) => {
    if (entry.is_dir && entry.children) {
      return { ...entry, children: sortEntries(entry.children) };
    }
    return entry;
  });
}

function renderSorted() {
  if (!fileTreeContainer || !currentEntries.length) return;
  const sorted = sortEntries(currentEntries);
  fileTreeContainer.innerHTML = '';
  for (const entry of sorted) {
    fileTreeContainer.appendChild(buildTreeItem(entry));
  }
}

export function loadDirectory(entries) {
  if (!fileTreeContainer) return;
  currentEntries = entries;
  renderSorted();
}

function buildTreeItem(entry) {
  const item = document.createElement('div');
  item.className = 'tree-item';

  if (entry.is_dir) {
    item.classList.add('tree-dir');
    item.dataset.path = entry.path;
    const isOpen = openDirs.has(entry.path);
    if (isOpen) item.classList.add('open');
    const label = document.createElement('div');
    label.className = 'tree-item-label';
    label.tabIndex = -1; // focusable for keyboard navigation
    const arrow = isOpen ? '\u25bc' : '\u25b6';
    label.innerHTML = `<span class="tree-icon">${arrow}</span><span>${escapeHtml(entry.name)}</span>`;
    label.addEventListener('click', () => {
      const open = item.classList.toggle('open');
      if (open) openDirs.add(entry.path);
      else openDirs.delete(entry.path);
      const icon = label.querySelector('.tree-icon');
      icon.textContent = open ? '\u25bc' : '\u25b6';
    });
    label.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (onContextMenu)
        onContextMenu({ path: entry.path, name: entry.name, isDir: true }, e.clientX, e.clientY);
    });
    item.appendChild(label);

    if (entry.children && entry.children.length > 0) {
      const children = document.createElement('div');
      children.className = 'tree-children';
      for (const child of entry.children) {
        children.appendChild(buildTreeItem(child));
      }
      item.appendChild(children);
    }
  } else {
    const label = document.createElement('div');
    label.className = 'tree-item-label';
    label.tabIndex = -1; // focusable for keyboard navigation
    label.dataset.path = entry.path;
    label.innerHTML = `<span class="tree-icon">\u{1f4c4}</span><span>${escapeHtml(entry.name)}</span>`;

    if (entry.path === activeFilePath) {
      label.classList.add('active');
    }

    label.addEventListener('click', () => {
      if (onFileSelect) onFileSelect(entry.path);
    });
    label.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (onContextMenu)
        onContextMenu({ path: entry.path, name: entry.name, isDir: false }, e.clientX, e.clientY);
    });
    item.appendChild(label);
  }

  return item;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

export function toggleSidebar() {
  const app = document.getElementById('app');
  if (app) {
    app.classList.toggle('sidebar-collapsed');
  }
}

export function isSidebarVisible() {
  const app = document.getElementById('app');
  return !!app && !app.classList.contains('sidebar-collapsed');
}

export function showSidebar() {
  const app = document.getElementById('app');
  if (app) app.classList.remove('sidebar-collapsed');
}

export function hideSidebar() {
  const app = document.getElementById('app');
  if (app) app.classList.add('sidebar-collapsed');
}

/**
 * Move keyboard focus into the file-tree pane (filer): the active file if
 * present, else the first item, else the container itself (empty tree).
 */
export function focusFiler() {
  const ft = document.getElementById('file-tree');
  if (!ft) return;
  const target =
    ft.querySelector('.tree-item-label.active') || ft.querySelector('.tree-item-label') || ft;
  target.focus();
}

/**
 * Pure decision for the sidebar focus-cycle key (Ctrl+Shift+E).
 * The cycle never hides the sidebar — it loops filer ⇄ outline, and Esc is the
 * way back to the editor. Given the current visibility and where focus is:
 *   hidden            → 'show-filer'   (reveal sidebar, focus filer)
 *   filer focused     → 'focus-outline'
 *   outline focused   → 'focus-filer'  (loop back, stays open)
 *   visible elsewhere → 'focus-filer'
 */
export function nextSidebarFocusAction({ visible, focusInFiler }) {
  if (!visible) return 'show-filer';
  if (focusInFiler) return 'focus-outline';
  return 'focus-filer';
}

export function highlightFile(path) {
  activeFilePath = path;
  if (!fileTreeContainer) return;

  fileTreeContainer.querySelectorAll('.tree-item-label.active').forEach((el) => {
    el.classList.remove('active');
  });

  fileTreeContainer.querySelectorAll('.tree-item-label[data-path]').forEach((el) => {
    if (el.dataset.path === path) {
      el.classList.add('active');
      // Expand parent directories (and remember them so a later re-render keeps
      // the path to the active file open).
      let parent = el.closest('.tree-dir');
      while (parent) {
        parent.classList.add('open');
        if (parent.dataset.path) openDirs.add(parent.dataset.path);
        const icon = parent.querySelector(':scope > .tree-item-label .tree-icon');
        if (icon) icon.textContent = '\u25bc';
        parent = parent.parentElement?.closest('.tree-dir');
      }
    }
  });
}

export function getShowAllFiles() {
  return showAllFiles;
}
