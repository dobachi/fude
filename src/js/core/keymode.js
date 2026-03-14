// keymode.js - Keyboard mode management (vim/emacs/normal)
import { toggleVim, getCurrentView } from './editor.js';
import { getAllPanes } from './panes.js';

let currentMode = 'normal';

export async function initKeymode(savedMode = 'normal') {
  await setMode(savedMode);
}

export async function setMode(mode) {
  currentMode = mode;

  const enable = mode === 'vim';

  // Apply to all pane views
  const panes = getAllPanes();
  for (const pane of panes) {
    if (pane.editorView) {
      await toggleVim(pane.editorView, enable);
    }
  }

  // Fallback: also apply to active view if panes not ready
  const view = getCurrentView();
  if (view) {
    await toggleVim(view, enable);
  }
}

export function getMode() {
  return currentMode;
}

export async function reapplyMode() {
  await setMode(currentMode);
}

export async function cycleMode() {
  const modes = ['normal', 'vim'];
  const index = modes.indexOf(currentMode);
  const next = modes[(index + 1) % modes.length];
  await setMode(next);
  return next;
}
