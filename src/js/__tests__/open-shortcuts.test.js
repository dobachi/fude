import { describe, it, expect } from 'vitest';
import { isOpenFileShortcut, isOpenFolderShortcut } from '../core/open-shortcuts.js';

const ev = (over = {}) => ({
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  key: 'o',
  ...over,
});

describe('isOpenFileShortcut', () => {
  it('matches Ctrl+O in normal mode', () => {
    expect(isOpenFileShortcut(ev({ ctrlKey: true }), 'normal')).toBe(true);
    expect(isOpenFileShortcut(ev({ metaKey: true }), 'normal')).toBe(true);
    expect(isOpenFileShortcut(ev({ ctrlKey: true, key: 'O' }), 'normal')).toBe(true);
  });

  it('does not match in vim/emacs (Ctrl-O is an editor key there)', () => {
    expect(isOpenFileShortcut(ev({ ctrlKey: true }), 'vim')).toBe(false);
    expect(isOpenFileShortcut(ev({ ctrlKey: true }), 'emacs')).toBe(false);
  });

  it('requires Ctrl/Cmd and rejects extra modifiers / other keys', () => {
    expect(isOpenFileShortcut(ev({}), 'normal')).toBe(false); // no ctrl
    expect(isOpenFileShortcut(ev({ ctrlKey: true, shiftKey: true }), 'normal')).toBe(false);
    expect(isOpenFileShortcut(ev({ ctrlKey: true, altKey: true }), 'normal')).toBe(false);
    expect(isOpenFileShortcut(ev({ ctrlKey: true, key: 'p' }), 'normal')).toBe(false);
  });
});

describe('isOpenFolderShortcut', () => {
  it('matches Ctrl+Shift+O in any mode', () => {
    expect(isOpenFolderShortcut(ev({ ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isOpenFolderShortcut(ev({ metaKey: true, shiftKey: true, key: 'O' }))).toBe(true);
  });

  it('rejects without Shift, with Alt, or for other keys', () => {
    expect(isOpenFolderShortcut(ev({ ctrlKey: true }))).toBe(false);
    expect(isOpenFolderShortcut(ev({ ctrlKey: true, shiftKey: true, altKey: true }))).toBe(false);
    expect(isOpenFolderShortcut(ev({ ctrlKey: true, shiftKey: true, key: 'k' }))).toBe(false);
  });
});
