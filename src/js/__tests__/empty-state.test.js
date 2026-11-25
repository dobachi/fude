import { describe, it, expect } from 'vitest';
import { EMPTY_STATE_HINTS, emptyStateHtml } from '../core/empty-state.js';
import { isOpenFileShortcut, isOpenFolderShortcut } from '../core/open-shortcuts.js';

// Turn "Ctrl+Shift+O" into the keydown it names.
function keydown(keys) {
  const parts = keys.split('+');
  const key = parts.pop();
  const shift = parts.includes('Shift');
  return {
    ctrlKey: parts.includes('Ctrl'),
    metaKey: false,
    shiftKey: shift,
    altKey: parts.includes('Alt'),
    key: shift ? key.toUpperCase() : key.toLowerCase(),
  };
}

const hint = (label) => EMPTY_STATE_HINTS.find(([, l]) => l === label)?.[0];

describe('empty-state hints', () => {
  it('advertise the keys that actually open a file and a folder', () => {
    const file = keydown(hint('Open file'));
    const folder = keydown(hint('Open folder'));
    expect(isOpenFileShortcut(file, 'normal')).toBe(true);
    expect(isOpenFolderShortcut(file)).toBe(false);
    expect(isOpenFolderShortcut(folder)).toBe(true);
    expect(isOpenFileShortcut(folder, 'normal')).toBe(false);
  });

  it('name Ctrl+Shift+T for a new tab, not the unbound Ctrl+N', () => {
    expect(hint('New tab')).toBe('Ctrl+Shift+T');
    expect(EMPTY_STATE_HINTS.some(([k]) => k === 'Ctrl+N')).toBe(false);
  });

  it('render every hint into the placeholder', () => {
    const el = document.createElement('div');
    el.innerHTML = emptyStateHtml();
    expect(el.querySelector('.empty-state-title').textContent).toBe('Fude');
    const kbds = [...el.querySelectorAll('.empty-state-hint kbd')].map((k) => k.textContent);
    expect(kbds).toEqual(EMPTY_STATE_HINTS.map(([k]) => k));
    expect(el.querySelector('.empty-state-hint').textContent).not.toContain('Ctrl+N');
  });
});
