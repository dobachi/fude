// keymode.js - Keyboard mode management (vim/emacs/normal)
import { toggleVim, getCurrentView } from './editor.js';

let currentMode = 'normal';

export async function initKeymode(savedMode = 'normal') {
  await setMode(savedMode);
}

export async function setMode(mode) {
  currentMode = mode;
  const view = getCurrentView();
  if (!view) return;

  switch (mode) {
    case 'vim':
      await toggleVim(view, true);
      break;
    case 'emacs':
      // TODO: Implement emacs keymap
      console.info('Emacs mode not yet implemented');
      await toggleVim(view, false);
      break;
    case 'normal':
    default:
      await toggleVim(view, false);
      break;
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
