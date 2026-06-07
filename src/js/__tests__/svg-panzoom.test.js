import { describe, it, expect } from 'vitest';
import { attachPanZoom, openFullscreen } from '../core/svg-panzoom.js';

function makeHolder() {
  const holder = document.createElement('div');
  holder.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
  document.body.appendChild(holder);
  return holder;
}

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

  it('zooms on wheel', () => {
    const holder = makeHolder();
    attachPanZoom(holder);
    holder.dispatchEvent(
      new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }),
    );
    const t = holder.querySelector('svg').style.transform;
    expect(t).toMatch(/scale\((?!1\))/); // scale changed away from exactly 1
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
});
