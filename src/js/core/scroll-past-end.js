// scroll-past-end.js - blank space below the end of a document, so the last
// lines can be lifted clear of whatever covers the bottom of the window.
//
// The space is half the height of the pane. A dashed rule marks where the
// document really ends, but only while the view is scrolled into that space:
// otherwise it would sit under the line being typed all the time.

/** Share of the pane's height added below the end of the document. */
export const PAST_END_RATIO = 0.5;

let enabled = true;
const listeners = new Set();

export function isScrollPastEndEnabled() {
  return enabled;
}

/** Turn the feature on or off for every editor and preview. */
export function setScrollPastEndEnabled(on) {
  const next = !!on;
  if (next === enabled) return;
  enabled = next;
  for (const fn of [...listeners]) fn(enabled);
}

/**
 * Be told when the feature is switched.
 * @param {(enabled: boolean) => void} fn
 * @returns {() => void} unsubscribe
 */
export function onScrollPastEndChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Height in px of the space below the document for a pane of the given height.
 * @param {number} clientHeight
 * @param {boolean} [on]
 */
export function pastEndSpace(clientHeight, on = enabled) {
  if (!on || !(clientHeight > 0)) return 0;
  return Math.floor(clientHeight * PAST_END_RATIO);
}

/**
 * The scroll position that puts the end of the document at the bottom of the
 * pane, i.e. the furthest one could scroll before the space was added.
 * @param {{scrollHeight: number, clientHeight: number}} m
 * @param {number} space
 */
export function naturalMaxScroll(m, space) {
  return Math.max(0, m.scrollHeight - m.clientHeight - Math.max(0, space));
}

/**
 * Whether the view has been scrolled into the space below the document.
 * @param {{scrollTop: number, scrollHeight: number, clientHeight: number}} m
 * @param {number} space
 */
export function isPastEnd(m, space) {
  if (!(space > 0)) return false;
  // Half a pixel of slack: fractional scroll positions on scaled displays.
  return m.scrollTop > naturalMaxScroll(m, space) + 0.5;
}

/**
 * Scroll so the end of the document sits at the bottom of the pane (what "go
 * to the end" means), rather than to the bottom of the space below it.
 * @param {HTMLElement} container
 */
export function scrollToDocumentEnd(container) {
  const space = pastEndSpace(container.clientHeight);
  container.scrollTop = naturalMaxScroll(container, space);
}

/**
 * Give a scrolling container (the preview) the space below its content and
 * the end-of-document rule. The space itself is drawn by CSS from the
 * `--past-end-space` variable; this keeps the variable and the classes current.
 * @param {HTMLElement} container
 * @returns {() => void} detach
 */
export function attachScrollPastEnd(container) {
  let space = -1;

  const flag = () => {
    container.classList.toggle('is-past-end', isPastEnd(container, space));
  };
  const refresh = () => {
    const next = pastEndSpace(container.clientHeight);
    if (next !== space) {
      space = next;
      container.classList.toggle('scroll-past-end', space > 0);
      container.style.setProperty('--past-end-space', `${space}px`);
    }
    flag();
  };

  container.addEventListener('scroll', flag, { passive: true });
  const off = onScrollPastEndChange(refresh);
  const Observer = globalThis.ResizeObserver;
  const observer = typeof Observer === 'function' ? new Observer(refresh) : null;
  if (observer) observer.observe(container);
  refresh();

  return () => {
    container.removeEventListener('scroll', flag);
    off();
    if (observer) observer.disconnect();
    container.classList.remove('scroll-past-end', 'is-past-end');
    container.style.removeProperty('--past-end-space');
  };
}
