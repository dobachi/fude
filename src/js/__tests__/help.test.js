import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('help module', () => {
  let mod;

  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = '';
    mod = await import('../help.js');
  });

  it('exports expected functions', () => {
    expect(typeof mod.openHelp).toBe('function');
    expect(typeof mod.closeHelp).toBe('function');
  });

  it('openHelp creates the help overlay in the DOM', () => {
    mod.openHelp();
    const overlay = document.querySelector('.help-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay.querySelector('.help-panel')).not.toBeNull();
    expect(overlay.querySelector('table')).not.toBeNull();
  });

  it('openHelp does not create duplicates', () => {
    mod.openHelp();
    mod.openHelp();
    const overlays = document.querySelectorAll('.help-overlay');
    expect(overlays.length).toBe(1);
  });

  it('closeHelp removes the overlay', () => {
    mod.openHelp();
    expect(document.querySelector('.help-overlay')).not.toBeNull();

    mod.closeHelp();
    expect(document.querySelector('.help-overlay')).toBeNull();
  });

  it('closeHelp is safe to call when not open', () => {
    expect(() => mod.closeHelp()).not.toThrow();
  });
});
