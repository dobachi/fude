import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  resolvePaneViewMode,
  ensurePaneViewControls,
  markViewModeButtons,
  paneViewControlsOf,
  VIEW_MODES,
} from '../core/pane-view-mode.js';

describe('resolvePaneViewMode', () => {
  it("prefers the pane's own mode", () => {
    expect(resolvePaneViewMode({ paneMode: 'preview', tabMode: 'editor' })).toBe('preview');
  });

  it("falls back to the mode remembered for the pane's file, then the default", () => {
    expect(resolvePaneViewMode({ paneMode: null, tabMode: 'editor' })).toBe('editor');
    expect(resolvePaneViewMode({ paneMode: null, tabMode: null, defaultMode: 'preview' })).toBe(
      'preview',
    );
  });

  it('ignores unknown values', () => {
    expect(resolvePaneViewMode({ paneMode: 'bogus', tabMode: 'nope', defaultMode: 'x' })).toBe(
      'split',
    );
  });

  it('knows the three modes', () => {
    expect(VIEW_MODES).toEqual(['editor', 'split', 'preview']);
  });
});

describe('per-pane view controls', () => {
  let template;
  let paneEl;

  beforeEach(() => {
    document.body.innerHTML = `
      <div id="view-mode-switch">
        <button class="view-mode-btn active" data-mode="editor" aria-label="エディタのみ"><svg></svg></button>
        <button class="view-mode-btn" data-mode="split" aria-label="分割"><svg></svg></button>
        <button class="view-mode-btn" data-mode="preview" aria-label="プレビューのみ"><svg></svg></button>
      </div>
      <div class="pane"><div class="editor-pane"></div></div>`;
    template = document.getElementById('view-mode-switch');
    paneEl = document.querySelector('.pane');
  });

  it('clones the tab bar buttons into the pane, without their state', () => {
    const controls = ensurePaneViewControls(paneEl, template, () => {});
    const btns = controls.querySelectorAll('.view-mode-btn');
    expect([...btns].map((b) => b.dataset.mode)).toEqual(['editor', 'split', 'preview']);
    expect(btns[0].classList.contains('active')).toBe(false);
    expect(btns[0].getAttribute('aria-label')).toBe('エディタのみ');
    expect(btns[0].querySelector('svg')).not.toBeNull();
    expect(paneViewControlsOf(paneEl)).toBe(controls);
  });

  it('creates the controls only once per pane', () => {
    const a = ensurePaneViewControls(paneEl, template, () => {});
    const b = ensurePaneViewControls(paneEl, template, () => {});
    expect(a).toBe(b);
    expect(paneEl.querySelectorAll('.pane-view-controls')).toHaveLength(1);
  });

  it('reports the clicked mode and keeps the click inside the controls', () => {
    const onSelect = vi.fn();
    const outer = vi.fn();
    paneEl.addEventListener('click', outer);
    const controls = ensurePaneViewControls(paneEl, template, onSelect);
    controls.querySelector('[data-mode="preview"]').click();
    expect(onSelect).toHaveBeenCalledWith('preview');
    expect(outer).not.toHaveBeenCalled();
  });

  it('does not affect the tab bar buttons', () => {
    const controls = ensurePaneViewControls(paneEl, template, () => {});
    markViewModeButtons(controls, 'preview');
    expect(template.querySelector('[data-mode="editor"]').classList.contains('active')).toBe(true);
    expect(template.querySelector('[data-mode="preview"]').classList.contains('active')).toBe(
      false,
    );
  });

  it('handles a missing pane or template', () => {
    expect(ensurePaneViewControls(null, template, () => {})).toBeNull();
    const controls = ensurePaneViewControls(paneEl, null, () => {});
    expect(controls.querySelectorAll('button')).toHaveLength(0);
  });
});

describe('markViewModeButtons', () => {
  it('presses exactly the button for the mode', () => {
    document.body.innerHTML = `<div id="g">
      <button class="view-mode-btn" data-mode="editor"></button>
      <button class="view-mode-btn" data-mode="split"></button></div>`;
    const g = document.getElementById('g');
    markViewModeButtons(g, 'split');
    const [e, s] = g.querySelectorAll('button');
    expect(s.classList.contains('active')).toBe(true);
    expect(s.getAttribute('aria-pressed')).toBe('true');
    expect(e.classList.contains('active')).toBe(false);
    expect(e.getAttribute('aria-pressed')).toBe('false');
    expect(() => markViewModeButtons(null, 'split')).not.toThrow();
  });
});
