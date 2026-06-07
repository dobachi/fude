// svg-panzoom.js - Lightweight, dependency-free wheel-zoom + drag-pan for an
// SVG rendered inside a holder element (used for PlantUML diagrams in preview).
// Wheel zooms toward the cursor, drag pans, double-click resets. A small control
// overlay (＋ − ⤢) appears on hover.

const MIN = 0.2;
const MAX = 12;

/**
 * Make the <svg> inside `holder` zoomable/pannable. Idempotent per holder.
 * @param {HTMLElement} holder
 */
export function attachPanZoom(holder) {
  if (!holder || holder.dataset.panzoom === '1') return;
  const svg = holder.querySelector('svg');
  if (!svg) return;
  holder.dataset.panzoom = '1';
  holder.classList.add('panzoom');

  let scale = 1;
  let tx = 0;
  let ty = 0;

  const apply = () => {
    svg.style.transformOrigin = '0 0';
    svg.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  };

  // Zoom by `factor` keeping the holder-relative point (cx, cy) stationary.
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

  holder.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const rect = holder.getBoundingClientRect();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
    },
    { passive: false },
  );

  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  holder.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    holder.classList.add('grabbing');
    try {
      holder.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  });
  holder.addEventListener('pointermove', (e) => {
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
    holder.classList.remove('grabbing');
    try {
      holder.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };
  holder.addEventListener('pointerup', endDrag);
  holder.addEventListener('pointercancel', endDrag);
  holder.addEventListener('dblclick', reset);

  const controls = document.createElement('div');
  controls.className = 'panzoom-controls';
  controls.innerHTML =
    '<button type="button" data-z="in" title="拡大">＋</button>' +
    '<button type="button" data-z="out" title="縮小">−</button>' +
    '<button type="button" data-z="reset" title="リセット">⤢</button>';
  // Don't let control interactions start a pan.
  controls.addEventListener('pointerdown', (e) => e.stopPropagation());
  controls.addEventListener('click', (e) => {
    const z = e.target?.dataset?.z;
    if (!z) return;
    const rect = holder.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    if (z === 'in') zoomAt(cx, cy, 1.25);
    else if (z === 'out') zoomAt(cx, cy, 1 / 1.25);
    else reset();
  });
  holder.appendChild(controls);

  apply();
}
