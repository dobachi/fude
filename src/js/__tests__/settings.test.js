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
  isLocalTauri: vi.fn(() => false),
  remoteSetup: vi.fn().mockResolvedValue({ ok: true, log: '' }),
  wslBridgeStatus: vi.fn().mockResolvedValue({ supported: false, distros: [] }),
  wslBridgeSet: vi.fn(),
  remoteOpen: vi.fn(),
  sshHostCandidates: vi.fn().mockResolvedValue([]),
  remoteComplete: vi.fn().mockResolvedValue([]),
  remoteConnections: vi.fn().mockResolvedValue([]),
  remoteDisconnect: vi.fn(),
  wslOpen: vi.fn(),
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

  it('points to the remote view in the desktop app only', async () => {
    const backend = await import('../backend.js');
    await mod.openSettings();
    expect(document.querySelector('#open-remote-view')).toBeNull();
    mod.closeSettings();

    backend.isLocalTauri.mockReturnValue(true);
    backend.getConfig.mockResolvedValueOnce({
      theme: 'dark',
      features: {},
      font_size: 14,
      has_api_key: false,
      api_key_storage: 'config_file',
    });
    await mod.openSettings();
    // The controls themselves no longer live in the settings.
    expect(document.querySelector('#remote-host')).toBeNull();
    document.querySelector('#open-remote-view').click();
    // The settings step aside for the view (its contents: remote-view.test.js).
    expect(document.querySelector('.settings-panel:not(.remote-panel)')).toBeNull();
    await vi.waitFor(() => expect(document.querySelector('.remote-panel')).not.toBeNull());
    expect(document.querySelector('.remote-panel #remote-open-path')).not.toBeNull();
    const { closeRemoteView } = await import('../features/remote/remote-view.js');
    closeRemoteView();
    backend.isLocalTauri.mockReturnValue(false);
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
    const hint = document.querySelector('.key-storage-hint');
    expect(hint).not.toBeNull();
    expect(hint.textContent).toContain('OS Keychain');
  });

  it('App Font Size slider updates --ui-font-size live', async () => {
    await mod.openSettings();
    const slider = document.querySelector('#setting-ui-fontsize');
    const value = document.querySelector('#setting-ui-fontsize-value');
    expect(slider).not.toBeNull();

    slider.value = '20';
    slider.dispatchEvent(new Event('input'));

    expect(document.documentElement.style.getPropertyValue('--ui-font-size')).toBe('20px');
    expect(value.textContent).toBe('20px');
  });

  it('save persists ui_font_size in the config', async () => {
    const backend = await import('../backend.js');
    await mod.openSettings();

    const slider = document.querySelector('#setting-ui-fontsize');
    slider.value = '18';
    slider.dispatchEvent(new Event('input'));

    document.querySelector('.btn-save-settings').click();
    await new Promise((r) => setTimeout(r, 50));

    const savedConfig = backend.saveConfig.mock.calls.at(-1)[0];
    expect(savedConfig.ui_font_size).toBe(18);
  });

  it('Scroll Past End is checked unless the config switches it off', async () => {
    const backend = await import('../backend.js');
    await mod.openSettings();
    expect(document.querySelector('#setting-scroll-past-end').checked).toBe(true);
    mod.closeSettings();

    backend.getConfig.mockResolvedValueOnce({
      theme: 'dark',
      features: { scroll_past_end: false },
      font_size: 14,
    });
    await mod.openSettings();
    expect(document.querySelector('#setting-scroll-past-end').checked).toBe(false);
  });

  it('save persists scroll_past_end in the config', async () => {
    const backend = await import('../backend.js');
    await mod.openSettings();
    document.querySelector('.btn-save-settings').click();
    await new Promise((r) => setTimeout(r, 50));
    expect(backend.saveConfig.mock.calls.at(-1)[0].features.scroll_past_end).toBe(true);

    await mod.openSettings();
    document.querySelector('#setting-scroll-past-end').checked = false;
    document.querySelector('.btn-save-settings').click();
    await new Promise((r) => setTimeout(r, 50));
    expect(backend.saveConfig.mock.calls.at(-1)[0].features.scroll_past_end).toBe(false);
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
