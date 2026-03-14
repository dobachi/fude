import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('backend module (Tauri mode)', () => {
  let mockInvoke;

  beforeEach(() => {
    // Reset module registry for fresh import
    vi.resetModules();

    // Set up mock Tauri global
    mockInvoke = vi.fn().mockResolvedValue('mock-result');
    window.__TAURI__ = {
      core: {
        invoke: mockInvoke,
      },
    };
  });

  afterEach(() => {
    delete window.__TAURI__;
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
    expect(mockInvoke).toHaveBeenCalledWith('read_dir_tree', { path: '/vault' });
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
    ];

    for (const [jsFn, tauriCmd] of mappings) {
      mockInvoke.mockClear();
      // Call with minimal args to avoid errors
      await mod[jsFn]('arg1', 'arg2');
      expect(mockInvoke).toHaveBeenCalled();
      expect(mockInvoke.mock.calls[0][0]).toBe(tauriCmd);
    }
  });
});
