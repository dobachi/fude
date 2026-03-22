// sidebar.js - Directory tree sidebar

let fileTreeContainer = null;
let onFileSelect = null;
let activeFilePath = null;
let currentEntries = [];
let currentSort = 'name_asc';
let showAllFiles = false;
let onSettingsChange = null;

const SORT_OPTIONS = {
  name_asc:      { key: 'name',     order: 'asc' },
  name_desc:     { key: 'name',     order: 'desc' },
  modified_desc: { key: 'modified', order: 'desc' },
  modified_asc:  { key: 'modified', order: 'asc' },
  created_desc:  { key: 'created',  order: 'desc' },
  created_asc:   { key: 'created',  order: 'asc' },
  size_desc:     { key: 'size',     order: 'desc' },
  size_asc:      { key: 'size',     order: 'asc' },
};

export function initSidebar(container, fileSelectCallback, opts) {
  fileTreeContainer = container;
  onFileSelect = fileSelectCallback;

  if (opts) {
    if (opts.sort) currentSort = opts.sort;
    if (opts.showAllFiles) showAllFiles = opts.showAllFiles;
    if (opts.onSettingsChange) onSettingsChange = opts.onSettingsChange;
  }

  initPopover();
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
    const label = document.createElement('div');
    label.className = 'tree-item-label';
    label.innerHTML = `<span class="tree-icon">\u25b6</span><span>${escapeHtml(entry.name)}</span>`;
    label.addEventListener('click', () => {
      item.classList.toggle('open');
      const icon = label.querySelector('.tree-icon');
      icon.textContent = item.classList.contains('open') ? '\u25bc' : '\u25b6';
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
    label.dataset.path = entry.path;
    label.innerHTML = `<span class="tree-icon">\u{1f4c4}</span><span>${escapeHtml(entry.name)}</span>`;

    if (entry.path === activeFilePath) {
      label.classList.add('active');
    }

    label.addEventListener('click', () => {
      if (onFileSelect) onFileSelect(entry.path);
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

export function highlightFile(path) {
  activeFilePath = path;
  if (!fileTreeContainer) return;

  fileTreeContainer.querySelectorAll('.tree-item-label.active').forEach((el) => {
    el.classList.remove('active');
  });

  fileTreeContainer.querySelectorAll('.tree-item-label[data-path]').forEach((el) => {
    if (el.dataset.path === path) {
      el.classList.add('active');
      // Expand parent directories
      let parent = el.closest('.tree-dir');
      while (parent) {
        parent.classList.add('open');
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
