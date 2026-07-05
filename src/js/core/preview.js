// preview.js - Markdown preview with markdown-it
import markdownIt from 'markdown-it';
import { convertFileSrc } from '@tauri-apps/api/core';
import { attachPanZoom } from './svg-panzoom.js';
import { highlightCode } from './code-highlight.js';
import { isLocalTauri } from '../backend.js';
import { openExternal, isExternalUrl } from './external-link.js';
import {
  isQuartoFile,
  applyQuartoExtensions,
  parseFrontMatter,
  renderFrontMatterHeader,
} from '../features/quarto/quarto-md.js';

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
let qmdMd = null;
let currentBasePath = '';
let gPending = false;
let qmdFrontMatterHtml = '';

function ensureMd() {
  if (md) return;
  md = createMd();
  // A second instance for .qmd files, carrying the same base rules plus the
  // Quarto extensions (front matter, callouts, executable-cell display).
  qmdMd = createMd();
  applyQuartoExtensions(qmdMd, {
    onFrontMatter: (fm) => {
      qmdFrontMatterHtml = renderFrontMatterHeader(parseFrontMatter(fm));
    },
  });
}

function createMd() {
  const md = markdownIt({
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
    // Respect an explicit id from Pandoc/Quarto attrs ({#sec-intro}); only
    // auto-generate a slug id when the heading doesn't already have one.
    const inline = tokens[idx + 1];
    const text = inline && inline.type === 'inline' ? inline.content : '';
    let slug = slugify(text);
    if (slug && !tokens[idx].attrGet('id')) {
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

  return md;
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

/**
 * Render a Quarto (.qmd) document: same as renderMarkdown but with the Quarto
 * extensions, and the parsed front-matter title block prepended to the body.
 */
export function renderQuartoMarkdown(text, basePath = '', container = null) {
  ensureMd();
  if (!container) return;
  currentBasePath = basePath;
  qmdFrontMatterHtml = ''; // reset; set by the front-matter callback during render
  const body = qmdMd.render(text);
  container.innerHTML = qmdFrontMatterHtml + body;
}

// ── PlantUML extension hook ────────────────────────────────

let plantumlEnabled = false;

/** Toggle PlantUML diagram rendering in the preview (set from config). */
export function setPlantumlEnabled(enabled) {
  plantumlEnabled = !!enabled;
}

// ── Mermaid extension hook ─────────────────────────────────

let mermaidEnabled = false;

/** Toggle Mermaid diagram rendering in the preview (set from config). */
export function setMermaidEnabled(enabled) {
  mermaidEnabled = !!enabled;
}

// ── Code syntax highlighting hook ──────────────────────────

let codeHighlightEnabled = false;

/** Toggle code-block syntax highlighting in the preview (set from config). */
export function setCodeHighlightEnabled(enabled) {
  codeHighlightEnabled = !!enabled;
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

// File extensions whose entire contents are a single Mermaid diagram.
const MERMAID_EXTS = ['mmd', 'mermaid'];

/** True if `path` is a standalone Mermaid file (rendered whole as one diagram). */
export function isMermaidFile(path) {
  if (!path) return false;
  const dot = path.lastIndexOf('.');
  if (dot < 0) return false;
  return MERMAID_EXTS.includes(path.slice(dot + 1).toLowerCase());
}

/** Render an entire document as a single Mermaid diagram into `container`. */
function renderMermaidDocument(content, container) {
  container.innerHTML = '';
  const holder = document.createElement('div');
  holder.className = 'mermaid-diagram';
  holder.setAttribute('data-source-line', '1');
  holder.textContent = '⏳ Mermaid…';
  container.appendChild(holder);

  import('../features/mermaid/adapter.js')
    .then((adapter) => adapter.renderMermaid(content))
    .then((svg) => {
      if (!holder.isConnected) return;
      holder.innerHTML = svg;
      attachPanZoom(holder);
    })
    .catch((err) => {
      if (!holder.isConnected) return;
      holder.classList.add('mermaid-error');
      holder.textContent = `Mermaid error: ${err.message}`;
    });
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
 * a Quarto (.qmd) file gets the Quarto extensions; everything else is plain
 * Markdown (with ```plantuml fences enhanced afterwards).
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
  if (mermaidEnabled && isMermaidFile(filePath)) {
    renderMermaidDocument(content, container);
    return;
  }
  if (isQuartoFile(filePath)) {
    renderQuartoMarkdown(content, basePath, container);
  } else {
    renderMarkdown(content, basePath, container);
  }
  enhancePreview(container);
}

/**
 * Post-render passes over freshly rendered Markdown: render PlantUML diagrams
 * and syntax-highlight code blocks. Each sub-pass is a no-op unless its feature
 * is enabled.
 * @param {HTMLElement} container
 */
export async function enhancePreview(container) {
  if (!container) return;
  // Diagrams first: they replace their <pre> with an SVG, so those blocks are
  // gone before the syntax-highlight pass scans the remaining code blocks.
  await renderPlantumlBlocks(container);
  await renderMermaidBlocks(container);
  await highlightCodeBlocks(container);
}

/**
 * Post-render pass: syntax-highlight fenced code blocks in place by reusing
 * the bundled CodeMirror language parsers. No-op unless enabled. Unknown
 * languages (or parse failures) leave the plain-text block untouched.
 * @param {HTMLElement} container
 */
async function highlightCodeBlocks(container) {
  if (!codeHighlightEnabled || !container) return;
  const codes = container.querySelectorAll('pre > code[class*="language-"]');
  await Promise.all(
    Array.from(codes).map(async (code) => {
      if (code.dataset.hlHandled) return;
      const cls = Array.from(code.classList).find((c) => c.startsWith('language-'));
      if (!cls) return;
      const lang = cls.slice('language-'.length);
      // PlantUML/Mermaid fences are handled by their own renderer (or left
      // plain when that extension is off); never syntax-highlight them.
      if (lang === 'plantuml' || lang === 'puml' || lang === 'mermaid') return;
      code.dataset.hlHandled = '1';
      const html = await highlightCode(code.textContent || '', lang);
      // Re-check connectivity: preview may have re-rendered while awaiting.
      if (html != null && code.isConnected) code.innerHTML = html;
    }),
  );
}

/**
 * Post-render pass: replace ```plantuml / ```puml code blocks with rendered
 * SVG. No-op unless the extension is enabled. The heavy engine adapter is
 * imported lazily and only when a diagram is actually present.
 * @param {HTMLElement} container
 */
async function renderPlantumlBlocks(container) {
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

/**
 * Post-render pass: replace ```mermaid code blocks with rendered SVG. No-op
 * unless the extension is enabled. The engine adapter is imported lazily and
 * only when a diagram is actually present.
 * @param {HTMLElement} container
 */
async function renderMermaidBlocks(container) {
  if (!mermaidEnabled || !container) return;
  const codes = container.querySelectorAll('pre > code.language-mermaid');
  if (!codes.length) return;

  let adapter;
  try {
    adapter = await import('../features/mermaid/adapter.js');
  } catch (e) {
    console.error('Failed to load Mermaid adapter:', e);
    return;
  }

  codes.forEach((code) => {
    const pre = code.parentElement;
    if (!pre || pre.dataset.mermaidHandled) return;
    pre.dataset.mermaidHandled = '1';

    const text = code.textContent || '';
    const line = pre.getAttribute('data-source-line') || '';
    const holder = document.createElement('div');
    holder.className = 'mermaid-diagram';
    if (line) holder.setAttribute('data-source-line', line);
    holder.textContent = '⏳ Mermaid…';
    pre.replaceWith(holder);

    adapter
      .renderMermaid(text)
      .then((svg) => {
        if (!holder.isConnected) return;
        holder.innerHTML = svg;
        attachPanZoom(holder);
      })
      .catch((err) => {
        if (!holder.isConnected) return;
        holder.classList.add('mermaid-error');
        holder.textContent = `Mermaid error: ${err.message}`;
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
 * Build a function returning an element's top in the container's scroll-content
 * coordinate space (0 = very top of content), consistent for ALL elements.
 *
 * We can't use `el.offsetTop`: it is measured from the element's offsetParent,
 * which for table rows is the <table> (and for other nested block elements can
 * be any positioned ancestor). Mixing those origins with the container's
 * scrollTop is what makes editor⇄preview sync drift around tables. A
 * getBoundingClientRect delta is origin-consistent regardless of nesting.
 * @param {HTMLElement} container
 * @param {number} scrollTop current container.scrollTop (passed so callers can
 *   read it once before mutating it)
 */
function makeTopWithin(container, scrollTop) {
  const containerTop = container.getBoundingClientRect().top;
  return (el) => el.getBoundingClientRect().top - containerTop + scrollTop;
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
  const topOf = makeTopWithin(container, scrollTop);
  let prev = null;
  let prevTop = 0;
  let next = null;
  let nextTop = 0;
  for (const el of elements) {
    const t = topOf(el);
    if (t <= scrollTop) {
      prev = el;
      prevTop = t;
    } else {
      next = el;
      nextTop = t;
      break;
    }
  }

  if (!prev) return parseFloat(elements[0].dataset.sourceLine);
  const prevLine = parseInt(prev.dataset.sourceLine, 10);
  if (!next) return prevLine;

  const nextLine = parseInt(next.dataset.sourceLine, 10);
  const span = nextTop - prevTop;
  if (span <= 0) return prevLine;
  const ratio = (scrollTop - prevTop) / span;
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

  const topOf = makeTopWithin(container, container.scrollTop);
  let prev = null;
  let prevTop = 0;
  let next = null;
  let nextTop = 0;
  for (const el of elements) {
    const elLine = parseInt(el.dataset.sourceLine, 10);
    if (elLine <= line) {
      prev = el;
      prevTop = topOf(el);
    } else {
      next = el;
      nextTop = topOf(el);
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
    const remainingHeight = container.scrollHeight - prevTop;
    // Heuristic: assume 1 line ≈ 24px in the remaining region
    target = prevTop + Math.min(remaining * 24, remainingHeight);
  } else {
    const prevLine = parseInt(prev.dataset.sourceLine, 10);
    const nextLine = parseInt(next.dataset.sourceLine, 10);
    const ratio = (line - prevLine) / (nextLine - prevLine);
    target = prevTop + (nextTop - prevTop) * ratio;
  }

  container.scrollTop = target;
}
