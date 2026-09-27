// pane-view-mode.js - each pane's view mode (editor / split / preview) and its
// own switch buttons.
//
// The view mode used to live only on the tab. Two panes showing the same file
// share that tab, so switching one switched both, and a pane with no file fell
// back to the *active* tab's mode. Now every pane holds its own mode; the tab
// only remembers the last mode used for that file, which a pane adopts when it
// switches to the tab.

export const VIEW_MODES = ['editor', 'split', 'preview'];
const CONTROLS_CLASS = 'pane-view-controls';

/**
 * The mode a pane should display.
 * @param {{paneMode?: string|null, tabMode?: string|null, defaultMode?: string}} p
 *   paneMode: the pane's own choice; tabMode: the mode remembered for the file
 *   it shows (null when it shows none); defaultMode: the app default
 * @returns {string}
 */
export function resolvePaneViewMode({ paneMode, tabMode, defaultMode = 'split' }) {
  if (VIEW_MODES.includes(paneMode)) return paneMode;
  if (VIEW_MODES.includes(tabMode)) return tabMode;
  return VIEW_MODES.includes(defaultMode) ? defaultMode : 'split';
}

/**
 * Give a pane its own view-mode buttons (once), cloned from the tab bar's so
 * the icons and labels are defined in one place. Clicking one calls
 * `onSelect(mode)`.
 *
 * @param {HTMLElement} paneEl the .pane element
 * @param {Element|null} template the tab bar's #view-mode-switch
 * @param {(mode: string) => void} onSelect
 * @returns {HTMLElement|null} the controls element
 */
export function ensurePaneViewControls(paneEl, template, onSelect) {
  if (!paneEl) return null;
  const existing = paneEl.querySelector(`:scope > .${CONTROLS_CLASS}`);
  if (existing) return existing;

  const doc = paneEl.ownerDocument;
  const controls = doc.createElement('div');
  controls.className = CONTROLS_CLASS;
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', 'このペインの表示の切り替え');

  const buttons = template ? template.querySelectorAll('.view-mode-btn') : [];
  for (const src of buttons) {
    const btn = src.cloneNode(true);
    btn.classList.remove('active');
    btn.removeAttribute('id');
    btn.addEventListener('click', (e) => {
      // The pane's own mousedown already made it the active pane; don't let
      // the click also bubble into editor/preview handlers.
      e.stopPropagation();
      onSelect(btn.dataset.mode);
    });
    controls.appendChild(btn);
  }
  paneEl.appendChild(controls);
  return controls;
}

/**
 * Mark the button for `mode` as pressed in a group of view-mode buttons.
 * @param {ParentNode|null} group
 * @param {string} mode
 */
export function markViewModeButtons(group, mode) {
  if (!group) return;
  group.querySelectorAll('.view-mode-btn').forEach((btn) => {
    const on = btn.dataset.mode === mode;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

/** The per-pane controls of a pane element, if created. */
export function paneViewControlsOf(paneEl) {
  return paneEl ? paneEl.querySelector(`:scope > .${CONTROLS_CLASS}`) : null;
}
