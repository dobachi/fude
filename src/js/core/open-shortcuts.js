// open-shortcuts.js - Pure decision helpers for the file/folder open
// shortcuts. Kept out of app.js so they can be unit-tested without the app's
// Tauri/DOM dependencies.

/**
 * Should a keydown trigger "Open File"? Bound to Ctrl/Cmd+O (no Shift/Alt).
 *
 * In vim/emacs, bare Ctrl-O already has an editor meaning (vim jumplist /
 * emacs open-line), so the shortcut is limited to normal mode; vim/emacs users
 * open files via the File menu instead.
 *
 * @param {KeyboardEvent} e
 * @param {string} mode current key mode ('normal' | 'vim' | 'emacs')
 * @returns {boolean}
 */
export function isOpenFileShortcut(e, mode) {
  return (
    (e.ctrlKey || e.metaKey) &&
    !e.shiftKey &&
    !e.altKey &&
    (e.key === 'o' || e.key === 'O') &&
    mode === 'normal'
  );
}

/**
 * Should a keydown trigger "Open Folder"? Bound to Ctrl/Cmd+Shift+O, which
 * works in every mode (Shift combos don't collide with editor keybindings).
 *
 * @param {KeyboardEvent} e
 * @returns {boolean}
 */
export function isOpenFolderShortcut(e) {
  return (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && (e.key === 'o' || e.key === 'O');
}
