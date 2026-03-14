// panes.js - Split pane management (VS Code-like)

let activePaneId = 'default';

export function initPanes() {
  activePaneId = 'default';
  updatePaneStyles();
}

export function splitVertical() {
  const workspace = document.getElementById('workspace');
  if (!workspace) return;

  workspace.classList.remove('split-horizontal');
  workspace.classList.add('split-vertical');

  const paneId = `pane-${Date.now()}`;
  const pane = document.createElement('div');
  pane.className = 'pane view-split';
  pane.dataset.paneId = paneId;
  pane.innerHTML = '<div class="editor-pane"></div><div class="preview-pane"></div>';
  workspace.appendChild(pane);

  setActivePane(paneId);
}

export function splitHorizontal() {
  const workspace = document.getElementById('workspace');
  if (!workspace) return;

  workspace.classList.remove('split-vertical');
  workspace.classList.add('split-horizontal');

  const paneId = `pane-${Date.now()}`;
  const pane = document.createElement('div');
  pane.className = 'pane view-split';
  pane.dataset.paneId = paneId;
  pane.innerHTML = '<div class="editor-pane"></div><div class="preview-pane"></div>';
  workspace.appendChild(pane);

  setActivePane(paneId);
}

export function closePane(id) {
  const workspace = document.getElementById('workspace');
  if (!workspace) return;

  const panes = workspace.querySelectorAll('.pane');
  if (panes.length <= 1) return;

  const pane = workspace.querySelector(`.pane[data-pane-id="${id}"]`);
  if (pane) {
    pane.remove();
  }

  const remaining = workspace.querySelectorAll('.pane');
  if (remaining.length === 1) {
    workspace.classList.remove('split-vertical', 'split-horizontal');
  }

  activePaneId = remaining[0]?.dataset.paneId || 'default';
  updatePaneStyles();
}

export function focusPane(direction) {
  const workspace = document.getElementById('workspace');
  if (!workspace) return;

  const panes = Array.from(workspace.querySelectorAll('.pane'));
  const currentIndex = panes.findIndex((p) => p.dataset.paneId === activePaneId);
  if (currentIndex === -1) return;

  let targetIndex;
  if (direction === 'right' || direction === 'down') {
    targetIndex = Math.min(currentIndex + 1, panes.length - 1);
  } else {
    targetIndex = Math.max(currentIndex - 1, 0);
  }

  if (targetIndex !== currentIndex) {
    setActivePane(panes[targetIndex].dataset.paneId);
  }
}

function setActivePane(id) {
  activePaneId = id;
  updatePaneStyles();
}

function updatePaneStyles() {
  const workspace = document.getElementById('workspace');
  if (!workspace) return;

  workspace.querySelectorAll('.pane').forEach((p) => {
    p.classList.toggle('active', p.dataset.paneId === activePaneId);
  });
}

export function getActivePane() {
  return activePaneId;
}

export function getActivePaneEditorContainer() {
  const pane = document.querySelector(`.pane[data-pane-id="${activePaneId}"]`);
  return pane ? pane.querySelector('.editor-pane') : null;
}

export function getActivePanePreviewContainer() {
  const pane = document.querySelector(`.pane[data-pane-id="${activePaneId}"]`);
  return pane ? pane.querySelector('.preview-pane') : null;
}
