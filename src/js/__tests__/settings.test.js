import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../backend.js', () => ({
  getConfig: vi.fn().mockResolvedValue({ theme: 'dark', features: {}, font_size: 14 }),
  saveConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../core/theme.js', () => ({
  applyTheme: vi.fn(),
  getCurrentTheme: vi.fn(() => 'dark'),
}));

vi.mock('../core/editor.js', () => ({
  setFontSize: vi.fn(),
  getFontSize: vi.fn(() => 14),
}));

vi.mock('../core/keymode.js', () => ({
  setMode: vi.fn(),
  getMode: vi.fn(() => 'normal'),
}));

describe('settings module', () => {
  let mod;

  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = '';
    mod = await import('../settings.js');
  });

  it('exports expected functions', () => {
    expect(typeof mod.openSettings).toBe('function');
    expect(typeof mod.closeSettings).toBe('function');
  });

  it('openSettings creates the settings overlay', async () => {
    await mod.openSettings();
    const overlay = document.querySelector('.settings-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay.querySelector('.settings-panel')).not.toBeNull();
  });

  it('openSettings does not create duplicates', async () => {
    await mod.openSettings();
    await mod.openSettings();
    const overlays = document.querySelectorAll('.settings-overlay');
    expect(overlays.length).toBe(1);
  });

  it('closeSettings removes the overlay', async () => {
    await mod.openSettings();
    expect(document.querySelector('.settings-overlay')).not.toBeNull();

    mod.closeSettings();
    expect(document.querySelector('.settings-overlay')).toBeNull();
  });

  it('closeSettings is safe to call when not open', () => {
    expect(() => mod.closeSettings()).not.toThrow();
  });
});
