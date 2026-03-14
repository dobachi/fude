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
