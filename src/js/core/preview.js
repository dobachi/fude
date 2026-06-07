// preview.js - Markdown preview with markdown-it
import markdownIt from 'markdown-it';
import { convertFileSrc } from '@tauri-apps/api/core';
import { attachPanZoom } from './svg-panzoom.js';
import { isLocalTauri } from '../backend.js';
import { openExternal, isExternalUrl } from './external-link.js';

// Build a URL-friendly slug from heading text. Lowercased, non-alphanumerics
// collapsed to "-". Used to give headings stable ids so internal links like
// [foo](#section) can scroll inside the preview.
function slugify(text) {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

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
      const src = token.attrs[srcIndex][1];
      // Skip remote URLs, data URIs, and the asset protocol itself (already
      // converted). Absolute paths are also taken as-is so users can target
      // an absolute file by writing ![alt](/abs/path/img.png).
      const isRemote = !src || /^(https?:|data:|asset:|blob:)/i.test(src);
      if (currentBasePath && !isRemote) {
        // Treat both POSIX and Windows roots as "absolute". A leading drive
        // letter like "C:\..." is also taken as absolute.
        const isAbsolute = /^(\/|\\|[A-Za-z]:[/\\])/.test(src);
        const joined = isAbsolute ? src : `${currentBasePath}/${src}`;
        // Convert any backslashes to forward slashes so the Tauri asset
        // protocol gets a clean URL path on Windows too.
        const abs = joined.replace(/\\/g, '/');
        // convertFileSrc picks the correct platform URL: asset://localhost/...
        // on Linux/macOS, https://asset.localhost/... on Windows. Requires
        // app.security.assetProtocol.enable = true in tauri.conf.json.
        if (isLocalTauri()) {
          token.attrs[srcIndex][1] = convertFileSrc(abs);
        }
        // In browser/dev mode leave the path untouched; the bundled server
        // can serve it from disk via its own routes if configured.
      }
    }
    return defaultImageRender(tokens, idx, options, env, self);
  };

  // Tag block-level elements with their source line for scroll sync.
  md.core.ruler.push('source_line', (state) => {
    for (const token of state.tokens) {
      if (!token.map) continue;
      if (
        token.type.endsWith('_open') ||
        token.type === 'code_block' ||
        token.type === 'fence' ||
        token.type === 'hr' ||
        token.type === 'html_block'
      ) {
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
      const langClass = token.info
        ? ` class="language-${escapeHtml(token.info.trim().split(/\s+/)[0])}"`
        : '';
      body = `<code${langClass}>${escapeHtml(token.content)}</code>`;
    } else {
      body = `<code${codeAttrs}>${escapeHtml(token.content)}</code>`;
    }
    return `<pre data-source-line="${line || ''}">${body}</pre>\n`;
  };
  md.renderer.rules.fence = renderFenceLike;
  md.renderer.rules.code_block = renderFenceLike;

  // Auto-id headings (h1..h6) using a slug of their text. Lets internal
  // anchor links like [back to top](#title) scroll inside the preview, and
  // keeps the Tauri webview from navigating to tauri.localhost/#... when
  // the click handler scrolls in-page.
  const seenIds = new WeakMap();
  md.renderer.rules.heading_open = function (tokens, idx, options, env, self) {
    const inline = tokens[idx + 1];
    const text = inline && inline.type === 'inline' ? inline.content : '';
    let slug = slugify(text);
    if (slug) {
      // Disambiguate duplicates per render env so repeated headings still
      // get unique ids ("foo", "foo-2", "foo-3", ...).
      const counts = seenIds.get(env) || new Map();
      const n = (counts.get(slug) || 0) + 1;
      counts.set(slug, n);
      seenIds.set(env, counts);
      if (n > 1) slug = `${slug}-${n}`;
      tokens[idx].attrSet('id', slug);
    }
    return self.renderToken(tokens, idx, options);
  };
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

  // Intercept ALL link clicks inside the preview. Without this the Tauri
  // webview will navigate itself away (e.g. an internal anchor like
  // [foo](#R1) bounces the URL to tauri.localhost/#R1 and unloads the app).
  //
  //   http/https/mailto → OS default browser
  //   #anchor           → scroll inside the preview to the matching id
  //   anything else     → no-op (relative paths etc. are ignored for now)
  container.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href) return;
    e.preventDefault();

    if (isExternalUrl(href)) {
      openExternal(href);
      return;
    }
    if (href.startsWith('#')) {
      const id = decodeURIComponent(href.slice(1));
      if (!id) return;
      // Prefer a strict id match; CSS.escape guards ids with punctuation.
      const target =
        container.querySelector(`#${CSS.escape(id)}`) ||
        container.querySelector(`[name="${CSS.escape(id)}"]`);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      return;
    }
    // Relative paths or other schemes: silently swallow to avoid webview
    // navigation. (Opening linked .md files in a new tab is a future feature.)
  });
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

// ── PlantUML extension hook ────────────────────────────────

let plantumlEnabled = false;

/** Toggle PlantUML diagram rendering in the preview (set from config). */
export function setPlantumlEnabled(enabled) {
  plantumlEnabled = !!enabled;
}

// File extensions whose entire contents are a single PlantUML diagram.
const PLANTUML_EXTS = ['puml', 'plantuml', 'uml', 'iuml', 'pu', 'wsd'];

/** True if `path` is a standalone PlantUML file (rendered whole as one diagram). */
export function isPlantumlFile(path) {
  if (!path) return false;
  const dot = path.lastIndexOf('.');
  if (dot < 0) return false;
  return PLANTUML_EXTS.includes(path.slice(dot + 1).toLowerCase());
}

/** Render an entire document as a single PlantUML diagram into `container`. */
function renderPlantumlDocument(content, container, baseDir) {
  container.innerHTML = '';
  const holder = document.createElement('div');
  holder.className = 'puml-diagram';
  holder.setAttribute('data-source-line', '1');
  holder.textContent = '⏳ PlantUML…';
  container.appendChild(holder);

  import('../features/plantuml/adapter.js')
    .then((adapter) => adapter.renderPlantUML(content, baseDir))
    .then((svg) => {
      if (!holder.isConnected) return;
      holder.innerHTML = svg;
      attachPanZoom(holder);
    })
    .catch((err) => {
      if (!holder.isConnected) return;
      holder.classList.add('puml-error');
      holder.textContent = `PlantUML error: ${err.message}`;
    });
}

/**
 * Render a document into the preview, choosing the right renderer: a standalone
 * PlantUML file (when the extension is enabled) is drawn as a single diagram;
 * everything else is Markdown (with ```plantuml fences enhanced afterwards).
 * @param {string} content
 * @param {string} basePath
 * @param {HTMLElement} container
 * @param {string} [filePath]
 */
export function renderPreview(content, basePath, container, filePath) {
  if (!container) return;
  if (plantumlEnabled && isPlantumlFile(filePath)) {
    renderPlantumlDocument(content, container, basePath);
    return;
  }
  renderMarkdown(content, basePath, container);
  enhancePreview(container);
}

/**
 * Post-render pass: replace ```plantuml / ```puml code blocks with rendered
 * SVG. No-op unless the extension is enabled. The heavy engine adapter is
 * imported lazily and only when a diagram is actually present.
 * @param {HTMLElement} container
 */
export async function enhancePreview(container) {
  if (!plantumlEnabled || !container) return;
  const codes = container.querySelectorAll(
    'pre > code.language-plantuml, pre > code.language-puml',
  );
  if (!codes.length) return;

  let adapter;
  try {
    adapter = await import('../features/plantuml/adapter.js');
  } catch (e) {
    console.error('Failed to load PlantUML adapter:', e);
    return;
  }

  codes.forEach((code) => {
    const pre = code.parentElement;
    if (!pre || pre.dataset.pumlHandled) return;
    pre.dataset.pumlHandled = '1';

    const text = code.textContent || '';
    const line = pre.getAttribute('data-source-line') || '';
    const holder = document.createElement('div');
    holder.className = 'puml-diagram';
    if (line) holder.setAttribute('data-source-line', line);
    holder.textContent = '⏳ PlantUML…';
    pre.replaceWith(holder);

    adapter
      .renderPlantUML(text, currentBasePath)
      .then((svg) => {
        if (!holder.isConnected) return;
        holder.innerHTML = svg;
        attachPanZoom(holder);
      })
      .catch((err) => {
        if (!holder.isConnected) return;
        holder.classList.add('puml-error');
        holder.textContent = `PlantUML error: ${err.message}`;
      });
  });
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
