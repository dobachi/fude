// outline.js - Document outline (table of contents) for the active markdown
// buffer. Extracts ATX headings, renders a clickable list in the sidebar,
// and tracks the current section based on editor scroll position.

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

/**
 * Initialise the outline panel. Stores the click target and the jump
 * callback; rendering is driven by render().
 */
export function initOutline(container, { onJump } = {}) {
  listContainer = container;
  onJumpCallback = onJump || null;
}

/** Move keyboard focus into the outline pane. */
export function focusOutline() {
  const ol = listContainer || document.getElementById('outline-list');
  if (ol) ol.focus();
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
    item.addEventListener('click', () => {
      if (onJumpCallback) onJumpCallback(h.line);
    });
    listContainer.appendChild(item);
  }
}

/**
 * Re-extract from text and render. Convenience wrapper.
 */
export function updateOutline(text) {
  renderOutline(extractHeadings(text));
}

/**
 * Highlight the heading that contains the given 1-based (possibly fractional)
 * editor line — i.e. the largest heading whose line ≤ given line.
 */
export function setActiveOutlineLine(line) {
  if (!listContainer) return;
  const items = listContainer.querySelectorAll('.outline-item');
  if (!items.length) return;

  let active = null;
  for (const el of items) {
    const itemLine = parseInt(el.dataset.line, 10);
    if (itemLine <= line) active = el;
    else break;
  }

  listContainer.querySelectorAll('.outline-item.active').forEach((el) => {
    if (el !== active) el.classList.remove('active');
  });
  if (active && !active.classList.contains('active')) {
    active.classList.add('active');
    // Keep the active heading visible inside the outline panel without
    // moving the surrounding page.
    active.scrollIntoView({ block: 'nearest' });
  }
}

export function clearOutline() {
  lastRenderedHeadings = [];
  if (listContainer) listContainer.innerHTML = '';
}
