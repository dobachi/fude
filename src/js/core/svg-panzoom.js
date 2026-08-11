// svg-panzoom.js - Lightweight, dependency-free wheel-zoom + drag-pan for an
// SVG rendered inside a holder (PlantUML diagrams in preview). Wheel zooms
// toward the cursor, drag pans, double-click resets. A control overlay
// (🔒 ＋ − ⟲ ⛶) appears on hover; ⛶ opens the diagram full-window so
// large/zoomed diagrams aren't cramped by the narrow preview pane.
//
// Inline diagrams start LOCKED: the wheel scrolls the preview past the diagram
// instead of being swallowed as zoom, which is what you want while reading a
// document top to bottom. 🔒 unlocks wheel-zoom and drag-pan. The lock is a
// single module-level flag shared by every diagram, because the preview is
// re-rendered (and holders recreated) on every edit — per-holder state would be
// thrown away on the next keystroke. The full-window view is always unlocked;
// there is nothing to scroll behind it.

const MIN = 0.2;
const MAX = 12;

const LOCK_GLYPH = '🔒';
const UNLOCK_GLYPH = '🔓';
const LOCK_TITLE = 'マウス操作を有効化（ホイールで拡大縮小・ドラッグで移動）';
const UNLOCK_TITLE = 'マウス操作を固定（ホイールはページスクロール）';

// Shared across all inline diagrams; the full-window view ignores it.
let interactive = false;

/** Is wheel-zoom / drag-pan currently enabled for inline diagrams? */
export function isPanZoomInteractive() {
  return interactive;
}

/** Enable/disable wheel-zoom + drag-pan for every inline diagram. */
export function setPanZoomInteractive(on) {
  interactive = !!on;
  document.querySelectorAll('.panzoom[data-panzoom="1"]').forEach(syncHolder);
}

// Reflect the shared lock state onto one holder and its lock button.
function syncHolder(holder) {
  holder.classList.toggle('panzoom-locked', !interactive);
  const btn = holder.querySelector('.panzoom-controls [data-z="lock"]');
  if (!btn) return;
  btn.textContent = interactive ? UNLOCK_GLYPH : LOCK_GLYPH;
  btn.title = interactive ? UNLOCK_TITLE : LOCK_TITLE;
  btn.classList.toggle('on', interactive);
  btn.setAttribute('aria-pressed', String(interactive));
}

// Wire wheel-zoom + drag-pan on `viewport`, transforming `svg`.
// `alwaysOn` bypasses the shared lock (full-window view).
function enablePanZoom(viewport, svg, { alwaysOn = false } = {}) {
  const enabled = () => alwaysOn || interactive;
  let scale = 1;
  let tx = 0;
  let ty = 0;

  const apply = () => {
    svg.style.transformOrigin = '0 0';
    svg.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  };
  const zoomAt = (cx, cy, factor) => {
    const next = Math.min(MAX, Math.max(MIN, scale * factor));
    const k = next / scale;
    tx = cx - k * (cx - tx);
    ty = cy - k * (cy - ty);
    scale = next;
    apply();
  };
  const reset = () => {
    scale = 1;
    tx = 0;
    ty = 0;
    apply();
  };

  viewport.addEventListener(
    'wheel',
    (e) => {
      // Locked: leave the event alone so the preview scrolls normally.
      if (!enabled()) return;
      e.preventDefault();
      const rect = viewport.getBoundingClientRect();
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.1 : 1 / 1.1);
    },
    { passive: false },
  );

  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  viewport.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !enabled()) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    viewport.classList.add('grabbing');
    try {
      viewport.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  });
  viewport.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    tx += e.clientX - lastX;
    ty += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    apply();
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    viewport.classList.remove('grabbing');
    try {
      viewport.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };
  viewport.addEventListener('pointerup', endDrag);
  viewport.addEventListener('pointercancel', endDrag);
  viewport.addEventListener('dblclick', reset);

  apply();
  return {
    reset,
    zoomCenter: (factor) => {
      const r = viewport.getBoundingClientRect();
      zoomAt(r.width / 2, r.height / 2, factor);
    },
  };
}

// Build a control bar. `onExpand` is null in the fullscreen view, which also
// has no lock button (it is always interactive).
function makeControls(pz, onExpand, { lock = false } = {}) {
  const controls = document.createElement('div');
  controls.className = 'panzoom-controls';
  let html = lock
    ? `<button type="button" data-z="lock" aria-pressed="false" title="${LOCK_TITLE}">${LOCK_GLYPH}</button>`
    : '';
  html +=
    '<button type="button" data-z="in" title="拡大">＋</button>' +
    '<button type="button" data-z="out" title="縮小">−</button>' +
    '<button type="button" data-z="reset" title="元のスケールに戻す">⟲</button>';
  if (onExpand) html += '<button type="button" data-z="full" title="全画面">⛶</button>';
  controls.innerHTML = html;
  controls.addEventListener('pointerdown', (e) => e.stopPropagation());
  controls.addEventListener('dblclick', (e) => e.stopPropagation());
  controls.addEventListener('click', (e) => {
    const z = e.target?.dataset?.z;
    if (!z) return;
    if (z === 'lock') setPanZoomInteractive(!interactive);
    else if (z === 'in') pz.zoomCenter(1.25);
    else if (z === 'out') pz.zoomCenter(1 / 1.25);
    else if (z === 'reset') pz.reset();
    else if (z === 'full' && onExpand) onExpand();
  });
  return controls;
}

/** Open `el` (an <svg> or <img>; a clone is used) full-window with pan/zoom. */
export function openFullscreen(el) {
  const overlay = document.createElement('div');
  overlay.className = 'panzoom-fullscreen';

  const stage = document.createElement('div');
  stage.className = 'panzoom-fs-stage';
  const svg = el.cloneNode(true);
  svg.style.transform = '';
  svg.removeAttribute('data-panzoom');
  stage.appendChild(svg);
  overlay.appendChild(stage);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'panzoom-fs-close';
  closeBtn.title = '閉じる (Esc)';
  closeBtn.textContent = '✕';
  overlay.appendChild(closeBtn);

  document.body.appendChild(overlay);
  const pz = enablePanZoom(stage, svg, { alwaysOn: true });
  overlay.appendChild(makeControls(pz, null));

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  closeBtn.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
}

/** Open an image (by URL) full-window with pan/zoom. */
export function openImageFullscreen(src) {
  const img = document.createElement('img');
  img.src = src;
  img.alt = '';
  img.draggable = false;
  openFullscreen(img);
}

/**
 * Make the <svg> inside `holder` zoomable/pannable inline, with a control bar
 * (including a full-window ⛶ button). Idempotent per holder.
 * @param {HTMLElement} holder
 */
export function attachPanZoom(holder) {
  if (!holder || holder.dataset.panzoom === '1') return;
  const target = holder.querySelector('svg, img');
  if (!target) return;
  holder.dataset.panzoom = '1';
  holder.classList.add('panzoom');
  // Images are draggable by default; that native drag steals pointer events and
  // breaks panning, so disable it.
  if (target.tagName.toLowerCase() === 'img') target.draggable = false;
  const pz = enablePanZoom(holder, target);
  holder.appendChild(makeControls(pz, () => openFullscreen(target), { lock: true }));
  syncHolder(holder);
}
