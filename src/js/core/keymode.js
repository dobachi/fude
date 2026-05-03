// keymode.js - Keyboard mode management (normal / vim / emacs)
import { toggleVim, toggleEmacs, getCurrentView } from './editor.js';
import { getAllPanes } from './panes.js';

const MODES = ['normal', 'vim', 'emacs'];
let currentMode = 'normal';

export async function initKeymode(savedMode = 'normal') {
  await setMode(MODES.includes(savedMode) ? savedMode : 'normal');
}

async function applyToView(view, mode) {
  if (!view) return;
  if (mode === 'vim') {
    await toggleVim(view, true);
  } else if (mode === 'emacs') {
    await toggleEmacs(view, true);
  } else {
    // normal: clear both
    await toggleVim(view, false);
  }
}

export async function setMode(mode) {
  currentMode = mode;

  const panes = getAllPanes();
  for (const pane of panes) {
    if (pane.editorView) {
      await applyToView(pane.editorView, mode);
    }
  }

  // Fallback: also apply to active view if panes not ready
  const view = getCurrentView();
  if (view) {
    await applyToView(view, mode);
  }

  updateModeIndicator(mode);
}

export function getMode() {
  return currentMode;
}

export async function reapplyMode() {
  await setMode(currentMode);
}

export async function cycleMode() {
  const index = MODES.indexOf(currentMode);
  const next = MODES[(index + 1) % MODES.length];
  await setMode(next);
  return next;
}

const MODE_LABELS = {
  vim: 'VIM',
  emacs: 'EMACS',
  normal: 'NORMAL',
};

let appVersion = '';

export function setAppVersion(v) {
  appVersion = v || '';
  // Re-render with current mode
  updateModeIndicator(currentMode);
}

export function getAppVersion() {
  return appVersion;
}

export function updateModeIndicator(mode) {
  let el = document.getElementById('mode-indicator');
  if (!el) {
    el = document.createElement('div');
    el.id = 'mode-indicator';
    document.body.appendChild(el);
  }
  const label = MODE_LABELS[mode] || 'NORMAL';
  const verPart = appVersion ? ` · v${appVersion}` : '';
  el.textContent = `${label}${verPart}`;
  el.hidden = false;
}
