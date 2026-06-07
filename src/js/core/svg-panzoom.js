// svg-panzoom.js - Lightweight, dependency-free wheel-zoom + drag-pan for an
// SVG rendered inside a holder (PlantUML diagrams in preview). Wheel zooms
// toward the cursor, drag pans, double-click resets. A control overlay
// (＋ − ⤢ ⛶) appears on hover; ⛶ opens the diagram full-window so large/zoomed
// diagrams aren't cramped by the narrow preview pane.

const MIN = 0.2;
const MAX = 12;

// Wire wheel-zoom + drag-pan on `viewport`, transforming `svg`.
function enablePanZoom(viewport, svg) {
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
    if (e.button !== 0) return;
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

// Build a control bar. `onExpand` is null in the fullscreen view.
function makeControls(pz, onExpand) {
  const controls = document.createElement('div');
  controls.className = 'panzoom-controls';
  let html =
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
    if (z === 'in') pz.zoomCenter(1.25);
    else if (z === 'out') pz.zoomCenter(1 / 1.25);
    else if (z === 'reset') pz.reset();
    else if (z === 'full' && onExpand) onExpand();
  });
  return controls;
}

/** Open `svgEl` (a clone is used) full-window with its own pan/zoom. */
export function openFullscreen(svgEl) {
  const overlay = document.createElement('div');
  overlay.className = 'panzoom-fullscreen';

  const stage = document.createElement('div');
  stage.className = 'panzoom-fs-stage';
  const svg = svgEl.cloneNode(true);
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
  const pz = enablePanZoom(stage, svg);
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

/**
 * Make the <svg> inside `holder` zoomable/pannable inline, with a control bar
 * (including a full-window ⛶ button). Idempotent per holder.
 * @param {HTMLElement} holder
 */
export function attachPanZoom(holder) {
  if (!holder || holder.dataset.panzoom === '1') return;
  const svg = holder.querySelector('svg');
  if (!svg) return;
  holder.dataset.panzoom = '1';
  holder.classList.add('panzoom');
  const pz = enablePanZoom(holder, svg);
  holder.appendChild(makeControls(pz, () => openFullscreen(svg)));
}
