import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../backend.js', () => ({
  browseDir: vi.fn().mockResolvedValue({ current: '/home', parent: '/', entries: [] }),
}));

describe('folder-picker module', () => {
  let mod;

  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = '';
    mod = await import('../folder-picker.js');
  });

  it('exports openFolderPicker function', () => {
    expect(typeof mod.openFolderPicker).toBe('function');
  });

  it('openFolderPicker creates an overlay in the DOM', () => {
    mod.openFolderPicker(vi.fn());
    const overlay = document.querySelector('.settings-overlay');
    expect(overlay).not.toBeNull();
  });
});
