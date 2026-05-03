import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('backend module (Tauri mode)', () => {
  let mockInvoke;
  let originalLocation;

  beforeEach(() => {
    vi.resetModules();

    // Mock __TAURI_INTERNALS__ (the low-level IPC bridge)
    mockInvoke = vi.fn().mockResolvedValue('mock-result');
    window.__TAURI_INTERNALS__ = {
      invoke: mockInvoke,
      transformCallback: vi.fn(),
    };

    // Simulate Tauri URL
    originalLocation = window.location;
    delete window.location;
    window.location = {
      protocol: 'tauri:',
      hostname: 'localhost',
      origin: 'tauri://localhost',
    };
  });

  afterEach(() => {
    delete window.__TAURI_INTERNALS__;
    window.location = originalLocation;
  });

  it('readFile calls invoke with read_file command', async () => {
    const mod = await import('../backend.js');
    await mod.readFile('/test.md');
    expect(mockInvoke).toHaveBeenCalledWith('read_file', { path: '/test.md' });
  });

  it('writeFile calls invoke with write_file command', async () => {
    const mod = await import('../backend.js');
    await mod.writeFile('/test.md', '# Content');
    expect(mockInvoke).toHaveBeenCalledWith('write_file', {
      path: '/test.md',
      content: '# Content',
    });
  });

  it('writeTempFile calls invoke with write_temp_file command', async () => {
    const mod = await import('../backend.js');
    await mod.writeTempFile('/test.md', 'draft');
    expect(mockInvoke).toHaveBeenCalledWith('write_temp_file', {
      path: '/test.md',
      content: 'draft',
    });
  });

  it('deleteTempFile calls invoke with delete_temp_file command', async () => {
    const mod = await import('../backend.js');
    await mod.deleteTempFile('/test.md');
    expect(mockInvoke).toHaveBeenCalledWith('delete_temp_file', { path: '/test.md' });
  });

  it('checkTempFiles calls invoke with check_temp_files command', async () => {
    const mod = await import('../backend.js');
    const paths = ['/a.md', '/b.md'];
    await mod.checkTempFiles(paths);
    expect(mockInvoke).toHaveBeenCalledWith('check_temp_files', { paths });
  });

  it('readDirTree calls invoke with read_dir_tree command', async () => {
    const mod = await import('../backend.js');
    await mod.readDirTree('/vault');
    expect(mockInvoke).toHaveBeenCalledWith('read_dir_tree', {
      path: '/vault',
      show_all_files: false,
    });
  });

  it('saveSession calls invoke with save_session command', async () => {
    const mod = await import('../backend.js');
    const session = { open_tabs: [], active_tab: 0 };
    await mod.saveSession(session);
    expect(mockInvoke).toHaveBeenCalledWith('save_session', { session });
  });

  it('loadSession calls invoke with load_session command', async () => {
    const mod = await import('../backend.js');
    await mod.loadSession();
    expect(mockInvoke).toHaveBeenCalledWith('load_session');
  });

  it('getConfig calls invoke with get_config command', async () => {
    const mod = await import('../backend.js');
    await mod.getConfig();
    expect(mockInvoke).toHaveBeenCalledWith('get_config');
  });

  it('saveConfig calls invoke with save_config command', async () => {
    const mod = await import('../backend.js');
    const config = { theme: 'dark' };
    await mod.saveConfig(config);
    expect(mockInvoke).toHaveBeenCalledWith('save_config', { config });
  });

  it('setApiKey calls invoke with set_api_key command', async () => {
    const mod = await import('../backend.js');
    await mod.setApiKey('sk-test-123');
    expect(mockInvoke).toHaveBeenCalledWith('set_api_key', { key: 'sk-test-123' });
  });

  it('deleteApiKey calls invoke with delete_api_key command', async () => {
    const mod = await import('../backend.js');
    await mod.deleteApiKey();
    expect(mockInvoke).toHaveBeenCalledWith('delete_api_key');
  });

  it('getOpenDir calls invoke with get_open_dir command', async () => {
    const mod = await import('../backend.js');
    await mod.getOpenDir();
    expect(mockInvoke).toHaveBeenCalledWith('get_open_dir');
  });

  it('browseDir calls invoke with browse_dir command', async () => {
    const mod = await import('../backend.js');
    await mod.browseDir('/home');
    expect(mockInvoke).toHaveBeenCalledWith('browse_dir', { path: '/home' });
  });

  it('browseDir with no argument sends empty string', async () => {
    const mod = await import('../backend.js');
    await mod.browseDir();
    expect(mockInvoke).toHaveBeenCalledWith('browse_dir', { path: '' });
  });

  it('function names map to correct Tauri command names', async () => {
    const mod = await import('../backend.js');

    const mappings = [
      ['readFile', 'read_file'],
      ['writeFile', 'write_file'],
      ['writeTempFile', 'write_temp_file'],
      ['deleteTempFile', 'delete_temp_file'],
      ['checkTempFiles', 'check_temp_files'],
      ['readDirTree', 'read_dir_tree'],
      ['saveSession', 'save_session'],
      ['loadSession', 'load_session'],
      ['getConfig', 'get_config'],
      ['saveConfig', 'save_config'],
      ['setApiKey', 'set_api_key'],
      ['deleteApiKey', 'delete_api_key'],
      ['getOpenDir', 'get_open_dir'],
      ['browseDir', 'browse_dir'],
    ];

    for (const [jsFn, tauriCmd] of mappings) {
      mockInvoke.mockClear();
      await mod[jsFn]('arg1', 'arg2');
      expect(mockInvoke).toHaveBeenCalled();
      expect(mockInvoke.mock.calls[0][0]).toBe(tauriCmd);
    }
  });
});

describe('backend module (HTTP fallback mode)', () => {
  let originalLocation;

  beforeEach(() => {
    vi.resetModules();

    // No Tauri internals
    delete window.__TAURI_INTERNALS__;

    originalLocation = window.location;
    delete window.location;
    window.location = {
      protocol: 'http:',
      hostname: 'localhost',
      origin: 'http://localhost:3000',
    };

    // Mock fetch
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: 'ok' }),
    });
  });

  afterEach(() => {
    window.location = originalLocation;
    delete globalThis.fetch;
  });

  it('readFile calls fetch with correct URL', async () => {
    const mod = await import('../backend.js');
    await mod.readFile('/test.md');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/read_file',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ path: '/test.md' }),
      }),
    );
  });

  it('writeFile calls fetch with correct URL and body', async () => {
    const mod = await import('../backend.js');
    await mod.writeFile('/test.md', '# Hello');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/write_file',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ path: '/test.md', content: '# Hello' }),
      }),
    );
  });

  it('throws when fetch response is not ok', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    const mod = await import('../backend.js');
    await expect(mod.readFile('/fail.md')).rejects.toThrow('Backend call failed: read_file');
  });

  it('uses https://tauri.localhost as Tauri mode', async () => {
    vi.resetModules();

    // Simulate Tauri via __TAURI_INTERNALS__ + https://tauri.localhost
    const mockInvoke = vi.fn().mockResolvedValue('tauri-result');
    window.__TAURI_INTERNALS__ = { invoke: mockInvoke, transformCallback: vi.fn() };
    delete window.location;
    window.location = {
      protocol: 'https:',
      hostname: 'tauri.localhost',
      origin: 'https://tauri.localhost',
    };

    const mod = await import('../backend.js');
    await mod.readFile('/via-https.md');
    expect(mockInvoke).toHaveBeenCalledWith('read_file', { path: '/via-https.md' });

    delete window.__TAURI_INTERNALS__;
  });
});
