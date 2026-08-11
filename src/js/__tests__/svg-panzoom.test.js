import { describe, it, expect, beforeEach } from 'vitest';
import {
  attachPanZoom,
  openFullscreen,
  openImageFullscreen,
  isPanZoomInteractive,
  setPanZoomInteractive,
} from '../core/svg-panzoom.js';

function makeHolder() {
  const holder = document.createElement('div');
  holder.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
  document.body.appendChild(holder);
  return holder;
}

function wheel(el, deltaY = -100) {
  const e = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
}

function drag(el, dx, dy) {
  el.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 0, clientY: 0 }));
  el.dispatchEvent(new MouseEvent('pointermove', { clientX: dx, clientY: dy }));
  el.dispatchEvent(new MouseEvent('pointerup', { clientX: dx, clientY: dy }));
}

const transformOf = (holder) => holder.querySelector('svg').style.transform;

// The lock is module-level state shared by every diagram; reset it (and the
// DOM, so stale holders don't get synced) between tests.
beforeEach(() => {
  document.body.innerHTML = '';
  setPanZoomInteractive(false);
});

describe('attachPanZoom', () => {
  it('marks the holder and adds controls + initial transform', () => {
    const holder = makeHolder();
    attachPanZoom(holder);
    expect(holder.classList.contains('panzoom')).toBe(true);
    expect(holder.dataset.panzoom).toBe('1');
    expect(holder.querySelector('.panzoom-controls')).toBeTruthy();
    expect(holder.querySelector('svg').style.transform).toContain('scale(1)');
  });

  it('is idempotent (no duplicate controls)', () => {
    const holder = makeHolder();
    attachPanZoom(holder);
    attachPanZoom(holder);
    expect(holder.querySelectorAll('.panzoom-controls').length).toBe(1);
  });

  it('zooms on wheel once unlocked', () => {
    const holder = makeHolder();
    attachPanZoom(holder);
    setPanZoomInteractive(true);
    wheel(holder);
    expect(transformOf(holder)).toMatch(/scale\((?!1\))/); // scale changed away from exactly 1
  });

  it('does nothing without an svg', () => {
    const holder = document.createElement('div');
    attachPanZoom(holder);
    expect(holder.classList.contains('panzoom')).toBe(false);
  });

  it('inline controls include the full-window button', () => {
    const holder = makeHolder();
    attachPanZoom(holder);
    expect(holder.querySelector('.panzoom-controls [data-z="full"]')).toBeTruthy();
  });
});

describe('wheel-zoom lock', () => {
  it('is locked by default: wheel neither zooms nor is swallowed', () => {
    const holder = makeHolder();
    attachPanZoom(holder);
    expect(isPanZoomInteractive()).toBe(false);
    expect(holder.classList.contains('panzoom-locked')).toBe(true);
    const e = wheel(holder);
    expect(transformOf(holder)).toContain('scale(1)');
    expect(e.defaultPrevented).toBe(false); // preview keeps scrolling
  });

  it('does not pan on drag while locked', () => {
    const holder = makeHolder();
    attachPanZoom(holder);
    drag(holder, 40, 25);
    expect(transformOf(holder)).toContain('translate(0px, 0px)');
  });

  it('pans on drag once unlocked', () => {
    const holder = makeHolder();
    attachPanZoom(holder);
    setPanZoomInteractive(true);
    drag(holder, 40, 25);
    expect(transformOf(holder)).toContain('translate(40px, 25px)');
  });

  it('the lock button toggles interaction and its own label', () => {
    const holder = makeHolder();
    attachPanZoom(holder);
    const btn = holder.querySelector('.panzoom-controls [data-z="lock"]');
    expect(btn.textContent).toBe('🔒');
    expect(btn.getAttribute('aria-pressed')).toBe('false');

    btn.click();
    expect(isPanZoomInteractive()).toBe(true);
    expect(btn.textContent).toBe('🔓');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.classList.contains('on')).toBe(true);
    expect(holder.classList.contains('panzoom-locked')).toBe(false);

    btn.click();
    expect(isPanZoomInteractive()).toBe(false);
    expect(btn.textContent).toBe('🔒');
    expect(holder.classList.contains('panzoom-locked')).toBe(true);
    wheel(holder);
    expect(transformOf(holder)).toContain('scale(1)');
  });

  it('the state is shared: unlocking one diagram unlocks the others', () => {
    const a = makeHolder();
    const b = makeHolder();
    attachPanZoom(a);
    attachPanZoom(b);

    a.querySelector('.panzoom-controls [data-z="lock"]').click();
    expect(b.classList.contains('panzoom-locked')).toBe(false);
    expect(b.querySelector('.panzoom-controls [data-z="lock"]').textContent).toBe('🔓');
    wheel(b);
    expect(transformOf(b)).toMatch(/scale\((?!1\))/);
  });

  it('a diagram rendered while unlocked starts unlocked', () => {
    setPanZoomInteractive(true);
    const holder = makeHolder();
    attachPanZoom(holder);
    expect(holder.classList.contains('panzoom-locked')).toBe(false);
    expect(holder.querySelector('.panzoom-controls [data-z="lock"]').textContent).toBe('🔓');
  });

  it('the ± and reset buttons work even while locked', () => {
    const holder = makeHolder();
    attachPanZoom(holder);
    holder.querySelector('.panzoom-controls [data-z="in"]').click();
    expect(transformOf(holder)).toMatch(/scale\((?!1\))/);
    holder.querySelector('.panzoom-controls [data-z="reset"]').click();
    expect(transformOf(holder)).toContain('scale(1)');
  });
});

describe('openFullscreen', () => {
  it('opens an overlay with a cloned svg and closes on Esc', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    openFullscreen(svg);
    const overlay = document.querySelector('.panzoom-fullscreen');
    expect(overlay).toBeTruthy();
    expect(overlay.querySelector('svg')).toBeTruthy();
    expect(overlay.querySelector('.panzoom-fs-close')).toBeTruthy();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.panzoom-fullscreen')).toBeFalsy();
  });

  it('zooms on wheel even while inline diagrams are locked, and has no lock button', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    openFullscreen(svg);
    const overlay = document.querySelector('.panzoom-fullscreen');
    const stage = overlay.querySelector('.panzoom-fs-stage');
    expect(overlay.querySelector('[data-z="lock"]')).toBeFalsy();
    wheel(stage);
    expect(stage.querySelector('svg').style.transform).toMatch(/scale\((?!1\))/);
  });

  it('openImageFullscreen shows an img overlay', () => {
    openImageFullscreen('asset://localhost/x.png');
    const overlay = document.querySelector('.panzoom-fullscreen');
    expect(overlay).toBeTruthy();
    const img = overlay.querySelector('img');
    expect(img).toBeTruthy();
    expect(img.getAttribute('src')).toBe('asset://localhost/x.png');
    overlay.querySelector('.panzoom-fs-close').click();
    expect(document.querySelector('.panzoom-fullscreen')).toBeFalsy();
  });
});
