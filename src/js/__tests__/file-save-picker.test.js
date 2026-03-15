import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../backend.js', () => ({
  browseDir: vi.fn().mockResolvedValue({ current: '/home', parent: '/', entries: [] }),
}));

describe('file-save-picker module', () => {
  let mod;

  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = '';
    mod = await import('../file-save-picker.js');
  });

  it('exports openSavePicker function', () => {
    expect(typeof mod.openSavePicker).toBe('function');
  });

  it('openSavePicker creates an overlay in the DOM', () => {
    mod.openSavePicker('/docs/test.md', vi.fn());
    const overlay = document.querySelector('.settings-overlay');
    expect(overlay).not.toBeNull();
  });
});
