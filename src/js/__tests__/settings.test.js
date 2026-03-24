import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../backend.js', () => ({
  getConfig: vi.fn().mockResolvedValue({
    theme: 'dark',
    features: {},
    font_size: 14,
    has_api_key: false,
    api_key_storage: 'config_file',
  }),
  saveConfig: vi.fn().mockResolvedValue(undefined),
  setApiKey: vi.fn().mockResolvedValue('config_file'),
  deleteApiKey: vi.fn().mockResolvedValue(undefined),
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

  it('shows empty API key field with placeholder when no key is set', async () => {
    await mod.openSettings();
    const input = document.querySelector('#setting-api-key');
    expect(input).not.toBeNull();
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('sk-or-...');
  });

  it('shows saved placeholder when has_api_key is true', async () => {
    const backend = await import('../backend.js');
    backend.getConfig.mockResolvedValueOnce({
      theme: 'dark',
      features: {},
      font_size: 14,
      has_api_key: true,
      api_key_storage: 'keychain',
    });

    mod.closeSettings();
    await mod.openSettings();
    const input = document.querySelector('#setting-api-key');
    expect(input.value).toBe('');
    expect(input.placeholder).toContain('saved');
    // Should show storage type hint
    const hint = document.querySelector('.setting-hint');
    expect(hint).not.toBeNull();
    expect(hint.textContent).toContain('OS Keychain');
  });

  it('save calls setApiKey when API key is provided', async () => {
    const backend = await import('../backend.js');
    await mod.openSettings();

    const input = document.querySelector('#setting-api-key');
    // Simulate user typing a key
    Object.defineProperty(input, 'value', { value: 'sk-or-test-key', writable: true });

    const saveBtn = document.querySelector('.btn-save-settings');
    saveBtn.click();
    // Wait for async save
    await new Promise((r) => setTimeout(r, 50));

    expect(backend.setApiKey).toHaveBeenCalledWith('sk-or-test-key');
    expect(backend.saveConfig).toHaveBeenCalled();
    // API key should not be in the config passed to saveConfig
    const savedConfig = backend.saveConfig.mock.calls[0][0];
    expect(savedConfig.openrouter_api_key).toBeNull();
  });

  it('save does not call setApiKey when API key is empty', async () => {
    const backend = await import('../backend.js');
    backend.setApiKey.mockClear();
    backend.saveConfig.mockClear();
    mod.closeSettings();
    await mod.openSettings();

    const saveBtn = document.querySelector('.btn-save-settings');
    saveBtn.click();
    await new Promise((r) => setTimeout(r, 50));

    expect(backend.setApiKey).not.toHaveBeenCalled();
    expect(backend.saveConfig).toHaveBeenCalled();
  });
});
