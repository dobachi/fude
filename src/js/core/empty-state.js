// empty-state.js - The placeholder shown in a pane with no document open.
//
// Shared by every place that empties a pane (no tab in the pane, last tab
// closed), so the shortcut hints cannot drift apart again: one copy once
// advertised Ctrl+N (unbound) and Ctrl+O as "Open folder" (it opens a file).

/** Shortcut hints, each [keys, label]. Keep in step with the key handlers. */
export const EMPTY_STATE_HINTS = [
  ['Ctrl+O', 'Open file'],
  ['Ctrl+Shift+O', 'Open folder'],
  ['Ctrl+Shift+T', 'New tab'],
];

/** The placeholder's HTML. */
export function emptyStateHtml() {
  const hints = EMPTY_STATE_HINTS.map(([keys, label]) => `<kbd>${keys}</kbd> ${label}`).join(
    ' &nbsp; ',
  );
  return `
    <div class="empty-state">
      <div class="empty-state-title">Fude</div>
      <div class="empty-state-hint">${hints}</div>
    </div>`;
}
