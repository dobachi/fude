// preview.js - Markdown preview with markdown-it
import markdownIt from 'markdown-it';

let md = null;
let currentBasePath = '';
let gPending = false;

function ensureMd() {
  if (md) return;

  md = markdownIt({
    html: false,
    linkify: true,
    typographer: true,
    breaks: true,
  });

  // Custom image renderer: resolve relative paths for local files
  const defaultImageRender =
    md.renderer.rules.image ||
    function (tokens, idx, options, env, self) {
      return self.renderToken(tokens, idx, options);
    };

  md.renderer.rules.image = function (tokens, idx, options, env, self) {
    const token = tokens[idx];
    const srcIndex = token.attrIndex('src');
    if (srcIndex >= 0) {
      let src = token.attrs[srcIndex][1];
      if (
        currentBasePath &&
        src &&
        !src.startsWith('http') &&
        !src.startsWith('data:') &&
        !src.startsWith('/')
      ) {
        token.attrs[srcIndex][1] = `asset://localhost/${currentBasePath}/${src}`;
      }
    }
    return defaultImageRender(tokens, idx, options, env, self);
  };

  // Tag block-level elements with their source line for scroll sync.
  md.core.ruler.push('source_line', (state) => {
    for (const token of state.tokens) {
      if (!token.map) continue;
      if (token.type.endsWith('_open') ||
          token.type === 'code_block' ||
          token.type === 'fence' ||
          token.type === 'hr' ||
          token.type === 'html_block') {
        token.attrSet('data-source-line', String(token.map[0] + 1)); // 1-based
      }
    }
  });

  // The default fence/code_block renderers ignore token attrs on the
  // outer <pre>; override so data-source-line lands on the scrollable element.
  const renderFenceLike = (tokens, idx, _options, _env, _slf) => {
    const token = tokens[idx];
    const line = token.attrGet('data-source-line');
    const codeAttrs = token.tag === 'code' ? '' : '';
    let body;
    if (token.type === 'fence') {
      const langClass = token.info ? ` class="language-${escapeHtml(token.info.trim().split(/\s+/)[0])}"` : '';
      body = `<code${langClass}>${escapeHtml(token.content)}</code>`;
    } else {
      body = `<code${codeAttrs}>${escapeHtml(token.content)}</code>`;
    }
    return `<pre data-source-line="${line || ''}">${body}</pre>\n`;
  };
  md.renderer.rules.fence = renderFenceLike;
  md.renderer.rules.code_block = renderFenceLike;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function handlePreviewKeys(e) {
  const container = e.currentTarget;
  if (!container) return;

  const scrollAmount = 60;
  const pageAmount = container.clientHeight * 0.8;

  switch (e.key) {
    case 'j':
      container.scrollTop += scrollAmount;
      e.preventDefault();
      break;
    case 'k':
      container.scrollTop -= scrollAmount;
      e.preventDefault();
      break;
    case 'd':
      container.scrollTop += pageAmount;
      e.preventDefault();
      break;
    case 'u':
      container.scrollTop -= pageAmount;
      e.preventDefault();
      break;
    case 'PageDown':
    case ' ':
      container.scrollTop += pageAmount;
      e.preventDefault();
      break;
    case 'PageUp':
      container.scrollTop -= pageAmount;
      e.preventDefault();
      break;
    case 'g':
      if (gPending) {
        container.scrollTop = 0;
        gPending = false;
        e.preventDefault();
      } else {
        gPending = true;
        setTimeout(() => {
          gPending = false;
        }, 500);
      }
      break;
    case 'G':
      container.scrollTop = container.scrollHeight;
      e.preventDefault();
      break;
  }
}

/**
 * Initialise a preview container (vim-like key navigation).
 * Can be called multiple times for different containers (one per pane).
 */
export function initPreview(container) {
  ensureMd();
  container.setAttribute('tabindex', '0');
  container.addEventListener('keydown', handlePreviewKeys);
}

/**
 * Render markdown into a specific container.
 * @param {string} text
 * @param {string} basePath
 * @param {HTMLElement} [container] - target container. If omitted, does nothing.
 */
export function renderMarkdown(text, basePath = '', container = null) {
  ensureMd();
  if (!container) return;
  currentBasePath = basePath;
  const html = md.render(text);
  container.innerHTML = html;
}

export function setTheme(_theme) {
  // Theme is handled via CSS data-theme attribute
}

export function setBasePath(path) {
  currentBasePath = path;
}

/**
 * Inverse of syncPreviewToLine: given the current preview scroll position,
 * return the corresponding source line (fractional, 1-based) or null if
 * the preview has no tagged elements.
 * @param {HTMLElement} container
 * @returns {number|null}
 */
export function getLineFromPreview(container) {
  if (!container) return null;
  const elements = container.querySelectorAll('[data-source-line]');
  if (elements.length === 0) return null;

  const scrollTop = container.scrollTop;
  let prev = null;
  let next = null;
  for (const el of elements) {
    if (el.offsetTop <= scrollTop) {
      prev = el;
    } else {
      next = el;
      break;
    }
  }

  if (!prev) return parseFloat(elements[0].dataset.sourceLine);
  const prevLine = parseInt(prev.dataset.sourceLine, 10);
  if (!next) return prevLine;

  const nextLine = parseInt(next.dataset.sourceLine, 10);
  const span = next.offsetTop - prev.offsetTop;
  if (span <= 0) return prevLine;
  const ratio = (scrollTop - prev.offsetTop) / span;
  return prevLine + (nextLine - prevLine) * ratio;
}

/**
 * Scroll preview to the position corresponding to a source line in the editor.
 * Uses data-source-line attributes added during rendering.
 * @param {HTMLElement} container preview container
 * @param {number} line 1-based source line (may be fractional for sub-line position)
 */
export function syncPreviewToLine(container, line) {
  if (!container) return;
  const elements = container.querySelectorAll('[data-source-line]');
  if (elements.length === 0) return;

  let prev = null;
  let next = null;
  for (const el of elements) {
    const elLine = parseInt(el.dataset.sourceLine, 10);
    if (elLine <= line) {
      prev = el;
    } else {
      next = el;
      break;
    }
  }

  let target;
  if (!prev) {
    // Above the first tagged element
    target = 0;
  } else if (!next) {
    // Past the last tagged element — interpolate to bottom
    const prevLine = parseInt(prev.dataset.sourceLine, 10);
    const remaining = Math.max(0, line - prevLine);
    const remainingHeight = container.scrollHeight - prev.offsetTop;
    // Heuristic: assume 1 line ≈ 24px in the remaining region
    target = prev.offsetTop + Math.min(remaining * 24, remainingHeight);
  } else {
    const prevLine = parseInt(prev.dataset.sourceLine, 10);
    const nextLine = parseInt(next.dataset.sourceLine, 10);
    const ratio = (line - prevLine) / (nextLine - prevLine);
    target = prev.offsetTop + (next.offsetTop - prev.offsetTop) * ratio;
  }

  container.scrollTop = target;
}
