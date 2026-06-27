// ui-font.js — app (chrome) font size, independent of the editor font size.
//
// The whole UI (sidebar, tabs, menus, dialogs, status bar, AI panel) is sized
// relative to the document root font-size via `rem`/`var(--ui-font-size)`, so
// changing this one value scales the entire chrome proportionally. The editor
// and preview panes stay on --font-size (see editor.js / style.css).

export const UI_FONT_MIN = 10;
export const UI_FONT_MAX = 28;
export const UI_FONT_DEFAULT = 14;

let currentUiFontSize = UI_FONT_DEFAULT;

/**
 * Pure: clamp an arbitrary value to a valid integer UI font size.
 * Non-numeric / NaN input falls back to the default.
 * @param {number} size
 * @returns {number}
 */
export function clampUiFontSize(size) {
  const n = Math.round(Number(size));
  if (!Number.isFinite(n)) return UI_FONT_DEFAULT;
  return Math.min(UI_FONT_MAX, Math.max(UI_FONT_MIN, n));
}

/** Apply and remember the app UI font size (clamped). Returns the applied value. */
export function setUiFontSize(size) {
  currentUiFontSize = clampUiFontSize(size);
  document.documentElement.style.setProperty('--ui-font-size', `${currentUiFontSize}px`);
  return currentUiFontSize;
}

/** The current app UI font size. */
export function getUiFontSize() {
  return currentUiFontSize;
}
