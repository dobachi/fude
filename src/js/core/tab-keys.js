// tab-keys.js — pure key→action mapping for tab switching.
// Kept dependency-free so it is trivially unit-testable.

/**
 * Map a keyboard event to a tab-switch action.
 * @param {{key: string, ctrlKey?: boolean, metaKey?: boolean, shiftKey?: boolean, altKey?: boolean}} e
 * @returns {'next' | 'prev' | null}
 *
 * Requires Ctrl (or Cmd on macOS) and no Alt. Bindings:
 *   Ctrl+Tab / Ctrl+PageDown      → 'next'
 *   Ctrl+Shift+Tab / Ctrl+PageUp  → 'prev'
 *
 * PageUp/PageDown ignore Shift and exist because WebKitGTK (Linux) swallows
 * Ctrl+Shift+Tab as backward focus navigation before it ever reaches JS, so
 * Ctrl+Shift+Tab works on Windows/macOS but not Linux. PageUp/PageDown are not
 * focus-navigation keys, so they reach JS on every platform (matches the
 * Ctrl+PageUp/PageDown tab switching in browsers and VS Code).
 */
export function tabActionForKey(e) {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod || e.altKey) return null;
  if (e.key === 'Tab') return e.shiftKey ? 'prev' : 'next';
  if (e.key === 'PageDown') return 'next';
  if (e.key === 'PageUp') return 'prev';
  return null;
}
