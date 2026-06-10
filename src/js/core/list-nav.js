// list-nav.js — keyboard navigation for the side-pane lists (filer / outline).
// Up/Down/Home/End move focus among the visible items; Enter activates the
// focused item (its click handler). Callers can inject list-specific keys
// (e.g. tree expand/collapse) via the `extra` hook.

/**
 * An item is navigable only if no collapsed ancestor directory hides it. The
 * file tree hides a directory's children with `display:none` on the
 * `.tree-children` wrapper of any `.tree-dir` that is not `.open`; flat lists
 * (the outline) have no such wrappers, so every item counts as visible.
 */
export function isItemVisible(el) {
  let node = el;
  while (node && node.parentElement) {
    if (node.classList && node.classList.contains('tree-children')) {
      const dir = node.parentElement;
      if (dir.classList.contains('tree-dir') && !dir.classList.contains('open')) {
        return false;
      }
    }
    node = node.parentElement;
  }
  return true;
}

/** Visible items matching `selector` inside `container`, in document order. */
export function getNavItems(container, selector) {
  if (!container) return [];
  return Array.from(container.querySelectorAll(selector)).filter(isItemVisible);
}

/**
 * Pure: the target index for a navigation key, or -1 if the key is not a
 * navigation key. `current` is the index of the focused item (-1 if none).
 */
export function nextNavIndex(key, current, length) {
  if (length === 0) return -1;
  switch (key) {
    case 'ArrowDown':
      return current < 0 ? 0 : Math.min(current + 1, length - 1);
    case 'ArrowUp':
      return current < 0 ? length - 1 : Math.max(current - 1, 0);
    case 'Home':
      return 0;
    case 'End':
      return length - 1;
    default:
      return -1;
  }
}

/**
 * Build a keydown handler for a list container.
 * @param {HTMLElement} container
 * @param {string} selector - CSS selector for navigable items.
 * @param {object} [opts]
 * @param {(e: KeyboardEvent, focused: HTMLElement|null, items: HTMLElement[], index: number) => boolean} [opts.extra]
 *        Optional hook for list-specific keys; return true if it handled the event.
 */
export function createListKeyHandler(container, selector, { extra } = {}) {
  return (e) => {
    const items = getNavItems(container, selector);
    const current = items.indexOf(document.activeElement);
    const focused = current >= 0 ? items[current] : null;

    if (extra && extra(e, focused, items, current)) return;

    if (e.key === 'Enter') {
      if (focused) {
        e.preventDefault();
        focused.click();
      }
      return;
    }

    const target = nextNavIndex(e.key, current, items.length);
    if (target >= 0) {
      e.preventDefault();
      items[target].focus();
    }
  };
}
