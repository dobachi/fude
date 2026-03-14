// sidebar.js - Directory tree sidebar

let fileTreeContainer = null;
let onFileSelect = null;
let activeFilePath = null;

export function initSidebar(container, fileSelectCallback) {
  fileTreeContainer = container;
  onFileSelect = fileSelectCallback;
}

export function loadDirectory(entries) {
  if (!fileTreeContainer) return;
  fileTreeContainer.innerHTML = '';

  for (const entry of entries) {
    fileTreeContainer.appendChild(buildTreeItem(entry));
  }
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
