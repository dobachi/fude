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

/**
 * Should a keydown trigger "Go to path" (open a file or folder by typing its
 * path)? Bound to Ctrl/Cmd+Shift+P, which works in every mode (Shift combos
 * don't collide with editor keybindings, and it avoids bare Ctrl+P which stays
 * with the editor — emacs previous-line / browser print).
 *
 * @param {KeyboardEvent} e
 * @returns {boolean}
 */
export function isGoToPathShortcut(e) {
  return (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && (e.key === 'p' || e.key === 'P');
}

/**
 * Should a keydown trigger "Print"? Bound to Ctrl/Cmd+P (no Shift/Alt) in
 * NORMAL mode only — in vim/emacs bare Ctrl-P is an editor key (emacs
 * previous-line), so those modes print via the File menu instead. Limiting it
 * to normal mode mirrors isOpenFileShortcut (Ctrl+O).
 *
 * @param {KeyboardEvent} e
 * @param {string} mode current key mode ('normal' | 'vim' | 'emacs')
 * @returns {boolean}
 */
export function isPrintShortcut(e, mode) {
  return (
    (e.ctrlKey || e.metaKey) &&
    !e.shiftKey &&
    !e.altKey &&
    (e.key === 'p' || e.key === 'P') &&
    mode === 'normal'
  );
}
