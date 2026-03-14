// preview.js - Markdown preview with markdown-it
import markdownIt from 'markdown-it';

let md = null;
let previewContainer = null;
let currentBasePath = '';
let gPending = false;

export function initPreview(container) {
  previewContainer = container;

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

  // Vim-like keyboard navigation in preview
  container.setAttribute('tabindex', '0');
  container.addEventListener('keydown', handlePreviewKeys);
}

function handlePreviewKeys(e) {
  if (!previewContainer) return;

  const scrollAmount = 60;
  const pageAmount = previewContainer.clientHeight * 0.8;

  switch (e.key) {
    case 'j':
      previewContainer.scrollTop += scrollAmount;
      e.preventDefault();
      break;
    case 'k':
      previewContainer.scrollTop -= scrollAmount;
      e.preventDefault();
      break;
    case 'd':
      previewContainer.scrollTop += pageAmount;
      e.preventDefault();
      break;
    case 'u':
      previewContainer.scrollTop -= pageAmount;
      e.preventDefault();
      break;
    case 'PageDown':
    case ' ':
      previewContainer.scrollTop += pageAmount;
      e.preventDefault();
      break;
    case 'PageUp':
      previewContainer.scrollTop -= pageAmount;
      e.preventDefault();
      break;
    case 'g':
      if (gPending) {
        previewContainer.scrollTop = 0;
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
      previewContainer.scrollTop = previewContainer.scrollHeight;
      e.preventDefault();
      break;
  }
}

export function renderMarkdown(text, basePath = '') {
  if (!md || !previewContainer) return;
  currentBasePath = basePath;
  const html = md.render(text);
  previewContainer.innerHTML = html;
}

export function setTheme(_theme) {
  // Theme is handled via CSS data-theme attribute
}

export function setBasePath(path) {
  currentBasePath = path;
}
