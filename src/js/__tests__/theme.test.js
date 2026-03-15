import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../core/editor.js', () => ({
  setTheme: vi.fn(),
  getCurrentView: vi.fn(() => null),
}));

vi.mock('../core/panes.js', () => ({
  applyThemeToAllPanes: vi.fn(),
}));

describe('theme module', () => {
  let mod;

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../core/theme.js');
  });

  it('exports expected functions', () => {
    expect(typeof mod.initTheme).toBe('function');
    expect(typeof mod.applyTheme).toBe('function');
    expect(typeof mod.getCurrentTheme).toBe('function');
    expect(typeof mod.toggleTheme).toBe('function');
  });

  it('getCurrentTheme returns dark by default', () => {
    expect(mod.getCurrentTheme()).toBe('dark');
  });

  it('applyTheme changes the theme', () => {
    mod.applyTheme('light');
    expect(mod.getCurrentTheme()).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('toggleTheme switches between dark and light', () => {
    mod.applyTheme('dark');
    const result = mod.toggleTheme();
    expect(result).toBe('light');
    expect(mod.getCurrentTheme()).toBe('light');

    const result2 = mod.toggleTheme();
    expect(result2).toBe('dark');
    expect(mod.getCurrentTheme()).toBe('dark');
  });

  it('initTheme applies the given theme', () => {
    mod.initTheme('light');
    expect(mod.getCurrentTheme()).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});
