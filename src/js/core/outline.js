// outline.js - Document outline (table of contents) for the active markdown
// buffer. Extracts ATX headings, renders a clickable list in the sidebar,
// and tracks the current section based on editor scroll position.

import { createListKeyHandler } from './list-nav.js';

/**
 * Extract ATX headings ("# ...", "## ...", etc.) from markdown source.
 * Lines inside fenced code blocks (``` or ~~~) are ignored so heading-like
 * comments inside code samples don't end up in the outline.
 *
 * Returns an array of { level, text, line } where line is 1-based.
 */
export function extractHeadings(text) {
  if (!text) return [];
  const lines = text.split('\n');
  const headings = [];
  let inFence = false;
  let fenceChar = null;
  let fenceLen = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track fenced code blocks. Opening and closing fences must use the
    // same character (` or ~) and the closing fence length must be ≥ opening.
    const fenceMatch = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      const ch = marker[0];
      if (!inFence) {
        inFence = true;
        fenceChar = ch;
        fenceLen = marker.length;
      } else if (ch === fenceChar && marker.length >= fenceLen) {
        inFence = false;
        fenceChar = null;
        fenceLen = 0;
      }
      continue;
    }
    if (inFence) continue;

    // ATX heading. Requires whitespace between hashes and content; trailing
    // hashes are optional ("## Title ##").
    const m = line.match(/^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/);
    if (m) {
      headings.push({
        level: m[1].length,
        text: m[2].trim(),
        line: i + 1,
      });
    }
  }

  return headings;
}

let listContainer = null;
let onJumpCallback = null;
let lastRenderedHeadings = [];
// Last editor line reported via setActiveOutlineLine. Kept so a re-render
// (typing, tab switch, external reload) restores the highlight instead of
// dropping it until the next scroll event.
let currentLine = 1;

/**
 * Index of the heading that "contains" the given 1-based (possibly fractional)
 * editor line: the last heading whose line ≤ given line. When the line sits
 * above the first heading (preamble / front matter) the first heading is
 * returned so the outline always shows where the reader is. Returns -1 only
 * when there are no headings. Pure — exported for testing.
 */
export function findActiveHeadingIndex(headings, line) {
  if (!headings || !headings.length) return -1;
  let idx = 0;
  for (let i = 0; i < headings.length; i++) {
    if (headings[i].line <= line) idx = i;
    else break;
  }
  return idx;
}

/**
 * Initialise the outline panel. Stores the click target and the jump
 * callback; rendering is driven by render().
 */
export function initOutline(container, { onJump } = {}) {
  listContainer = container;
  onJumpCallback = onJump || null;
  if (container) {
    container.addEventListener('keydown', createListKeyHandler(container, '.outline-item'));
  }
}

/**
 * Move keyboard focus into the outline pane: the active heading if present,
 * else the first heading, else the container itself (empty outline).
 */
export function focusOutline() {
  const ol = listContainer || document.getElementById('outline-list');
  if (!ol) return;
  const target =
    ol.querySelector('.outline-item.active') || ol.querySelector('.outline-item') || ol;
  target.focus();
}

/**
 * Render the outline list from headings. Replaces the current contents.
 */
export function renderOutline(headings) {
  if (!listContainer) return;
  lastRenderedHeadings = headings || [];
  listContainer.innerHTML = '';

  if (!lastRenderedHeadings.length) {
    const empty = document.createElement('div');
    empty.className = 'outline-empty';
    empty.textContent = 'No headings';
    listContainer.appendChild(empty);
    return;
  }

  for (const h of lastRenderedHeadings) {
    const item = document.createElement('div');
    item.className = `outline-item outline-level-${h.level}`;
    item.dataset.line = String(h.line);
    item.textContent = h.text;
    item.title = h.text; // tooltip for truncated long titles
    item.tabIndex = -1; // focusable for keyboard navigation
    item.addEventListener('click', () => {
      if (onJumpCallback) onJumpCallback(h.line);
    });
    listContainer.appendChild(item);
  }
  applyActive(false);
}

/**
 * Re-extract from text and render. Convenience wrapper.
 */
export function updateOutline(text) {
  renderOutline(extractHeadings(text));
}

/**
 * Which editor line the outline highlight should follow, by view mode.
 *   editor / split → the cursor line (where the user is writing). Scrolling
 *                    alone does not move the highlight.
 *   preview        → the source line at the top of the preview, since there
 *                    is no visible cursor. Falls back to the cursor line (then
 *                    line 1) while the preview has not rendered yet.
 * Pure — exported for testing.
 */
export function pickOutlineLine({ viewMode, cursorLine, previewTopLine } = {}) {
  const valid = (n) => typeof n === 'number' && !Number.isNaN(n);
  if (viewMode === 'preview' && valid(previewTopLine)) return previewTopLine;
  if (valid(cursorLine)) return cursorLine;
  return 1;
}

/**
 * Highlight the heading that contains the given 1-based (possibly fractional)
 * editor line — i.e. the largest heading whose line ≤ given line, or the first
 * heading when the line is above every heading.
 */
export function setActiveOutlineLine(line) {
  if (typeof line === 'number' && !Number.isNaN(line)) currentLine = line;
  applyActive(true);
}

/** The editor line the outline highlight is currently based on. */
export function getActiveOutlineLine() {
  return currentLine;
}

function applyActive(scroll) {
  if (!listContainer) return;
  const items = listContainer.querySelectorAll('.outline-item');
  if (!items.length) return;

  const headings = Array.from(items, (el) => ({ line: parseInt(el.dataset.line, 10) }));
  const idx = findActiveHeadingIndex(headings, currentLine);
  const active = idx >= 0 ? items[idx] : null;

  listContainer.querySelectorAll('.outline-item.active').forEach((el) => {
    if (el !== active) el.classList.remove('active');
  });
  if (active && !active.classList.contains('active')) {
    active.classList.add('active');
    // Keep the active heading visible inside the outline panel without
    // moving the surrounding page. Skipped on re-render: scrolling the panel
    // on every keystroke-driven rebuild would fight the user's own scrolling.
    if (scroll && typeof active.scrollIntoView === 'function') {
      active.scrollIntoView({ block: 'nearest' });
    }
  }
}

export function clearOutline() {
  lastRenderedHeadings = [];
  currentLine = 1;
  if (listContainer) listContainer.innerHTML = '';
}
