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

  // remote://host/... は接続中の fude-cli エージェントが持つファイル。読み書き・
  // ツリー・監視だけが remote_* コマンドに振り分けられ、それ以外は従来どおり。
  it('remote:// のパスは remote_* コマンドへ振り分ける', async () => {
    const mod = await import('../backend.js');
    const p = 'remote://box/home/u/a.md';
    await mod.readFile(p);
    expect(mockInvoke).toHaveBeenCalledWith('remote_read_file', { path: p });
    await mod.writeFile(p, 'x');
    expect(mockInvoke).toHaveBeenCalledWith('remote_write_file', { path: p, content: 'x' });
    await mod.readDirTree('remote://box/home/u', true);
    expect(mockInvoke).toHaveBeenCalledWith('remote_read_dir_tree', {
      path: 'remote://box/home/u',
      showAllFiles: true,
    });
    await mod.watchFile(p);
    expect(mockInvoke).toHaveBeenCalledWith('remote_watch_file', { path: p });
    await mod.unwatchFile(p);
    expect(mockInvoke).toHaveBeenCalledWith('remote_unwatch_file', { path: p });
    // 暫定保存はローカル側に残る（リモートが落ちても復元できるように）
    await mod.writeTempFile(p, 'draft');
    expect(mockInvoke).toHaveBeenCalledWith('write_temp_file', { path: p, content: 'draft' });
    await mod.remoteHosts();
    expect(mockInvoke).toHaveBeenCalledWith('remote_hosts');
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
    // Tauri v2 maps Rust snake_case args to camelCase on the JS side. A
    // snake_case key is silently ignored and the Option<bool> falls back to
    // None, so "show all files" never reached the backend (regression).
    expect(mockInvoke).toHaveBeenCalledWith('read_dir_tree', {
      path: '/vault',
      showAllFiles: false,
    });
  });

  it('readDirTree forwards showAllFiles=true in camelCase', async () => {
    const mod = await import('../backend.js');
    await mod.readDirTree('/vault', true);
    expect(mockInvoke).toHaveBeenCalledWith('read_dir_tree', {
      path: '/vault',
      showAllFiles: true,
    });
    const args = mockInvoke.mock.calls.at(-1)[1];
    expect(args).not.toHaveProperty('show_all_files');
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

  // The HTTP fallback exposes the same filesystem power as the Tauri backend,
  // so serve.js requires a session token on every call. If these break, the
  // browser-mode UI silently loses its authentication.
  it('sends the session token on API calls', async () => {
    window.location.search = '?token=secret-token';
    window.history.replaceState = vi.fn();

    const mod = await import('../backend.js');
    mod.captureTokenFromUrl();
    await mod.readFile('/test.md');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/read_file',
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-Fude-Token': 'secret-token' }),
      }),
    );
  });

  it('sends the session token on the AI stream call', async () => {
    window.location.search = '?token=secret-token';
    window.history.replaceState = vi.fn();
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, text: () => Promise.resolve('no') });

    const mod = await import('../backend.js');
    mod.captureTokenFromUrl();
    await mod.aiChatStream(
      [],
      'x',
      () => {},
      () => {},
      () => {},
    );

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/ai_chat_stream',
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-Fude-Token': 'secret-token' }),
      }),
    );
  });

  it('explains how to recover when the server rejects the token', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });

    const mod = await import('../backend.js');
    await expect(mod.readFile('/test.md')).rejects.toThrow(/token/i);
  });

  // #20: a rejected key must not keep firing requests (each counted as a
  // failure by the server), and a lockout must be reported, not swallowed.
  it('stops calling the server once the key has been rejected', async () => {
    window.location.search = '?token=stale';
    window.history.replaceState = vi.fn();
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });

    const mod = await import('../backend.js');
    mod.captureTokenFromUrl();
    await expect(mod.readFile('/a.md')).rejects.toThrow(/token/i);
    await expect(mod.readFile('/b.md')).rejects.toThrow(/token/i);
    await expect(mod.loadSession()).rejects.toThrow(/token/i);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('reports a lockout (429) with the Retry-After seconds', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: { get: (h) => (h.toLowerCase() === 'retry-after' ? '840' : null) },
    });
    const mod = await import('../backend.js');
    const { LOCKED_OUT_EVENT } = await import('../browser-token.js');
    const heard = vi.fn();
    window.addEventListener(LOCKED_OUT_EVENT, heard);
    await expect(mod.readFile('/a.md')).rejects.toThrow(/locked out/i);
    window.removeEventListener(LOCKED_OUT_EVENT, heard);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(heard.mock.calls[0][0].detail).toEqual({ retryAfterSec: 840 });
  });

  it('reports a lockout without Retry-After as unknown duration', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: { get: () => null },
    });
    const mod = await import('../backend.js');
    const { LOCKED_OUT_EVENT } = await import('../browser-token.js');
    const heard = vi.fn();
    window.addEventListener(LOCKED_OUT_EVENT, heard);
    await expect(mod.readFile('/a.md')).rejects.toThrow();
    window.removeEventListener(LOCKED_OUT_EVENT, heard);
    expect(heard.mock.calls[0][0].detail).toEqual({ retryAfterSec: null });
  });

  it('fetches an image as a Blob with the auth header', async () => {
    window.location.search = '?token=secret-token';
    window.history.replaceState = vi.fn();
    const blob = new Blob(['png'], { type: 'image/png' });
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve(blob) });
    const mod = await import('../backend.js');
    mod.captureTokenFromUrl();
    await expect(mod.readImageBlob('/n/a.png')).resolves.toBe(blob);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/read_image_file',
      expect.objectContaining({
        body: JSON.stringify({ path: '/n/a.png' }),
        headers: expect.objectContaining({ 'X-Fude-Token': 'secret-token' }),
      }),
    );
  });

  it('sends a pasted image as base64 in browser mode', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve('assets/pasted-image.png'),
    });
    const mod = await import('../backend.js');
    await expect(mod.saveImageBytes([137, 80, 0, 255], '/n/doc.md', 'png')).resolves.toBe(
      'assets/pasted-image.png',
    );
    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body).toEqual({ base64: 'iVAA/w==', docPath: '/n/doc.md', ext: 'png' });
  });

  it('asks the server for the startup folders in browser mode', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ open_dir: '/r/sub', root: '/r' }),
    });
    const mod = await import('../backend.js');
    await expect(mod.getStartupDirs()).resolves.toEqual({ open_dir: '/r/sub', root: '/r' });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/get_startup_dirs',
      expect.anything(),
    );
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

  it('detects Tauri via __TAURI_INTERNALS__ even when the URL is non-tauri (Linux/WSLg WebKitGTK)', async () => {
    vi.resetModules();

    // Regression: on some Linux/WebKitGTK builds the location is a plain
    // http://localhost (neither `tauri:` nor `tauri.localhost`), but the IPC
    // bridge is injected. We must still run in Tauri mode (invoke), not fall
    // back to HTTP — otherwise config/session/file access silently break.
    const mockInvoke = vi.fn().mockResolvedValue('tauri-result');
    window.__TAURI_INTERNALS__ = { invoke: mockInvoke, transformCallback: vi.fn() };
    globalThis.fetch = vi.fn();
    delete window.location;
    window.location = {
      protocol: 'http:',
      hostname: 'localhost',
      origin: 'http://localhost',
    };

    const mod = await import('../backend.js');
    expect(mod.isLocalTauri()).toBe(true);
    await mod.readFile('/via-internals.md');
    expect(mockInvoke).toHaveBeenCalledWith('read_file', { path: '/via-internals.md' });
    expect(globalThis.fetch).not.toHaveBeenCalled();

    delete window.__TAURI_INTERNALS__;
  });
});

// Browser mode used to fail every install with "only available in the desktop
// app"; fude-browser now downloads on the server and streams progress back.
describe('installExtension (HTTP fallback mode)', () => {
  let originalLocation;

  /** A fetch Response whose body yields `chunks` (strings) as bytes. */
  function streamResponse(chunks) {
    const enc = new TextEncoder();
    let i = 0;
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () =>
            i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true },
        }),
      },
    };
  }

  beforeEach(() => {
    vi.resetModules();
    delete window.__TAURI_INTERNALS__;
    originalLocation = window.location;
    delete window.location;
    window.location = { protocol: 'http:', hostname: 'localhost', origin: 'http://localhost:3000' };
  });

  afterEach(() => {
    window.location = originalLocation;
    delete globalThis.fetch;
  });

  async function run() {
    const mod = await import('../backend.js');
    const calls = { progress: [], done: 0, errors: [] };
    await mod.installExtension(
      'mermaid',
      (p, t) => calls.progress.push([p, t]),
      () => calls.done++,
      (e) => calls.errors.push(e.message),
    );
    return calls;
  }

  it('posts to install_extension and relays progress then done', async () => {
    // An event split across chunks must still be parsed whole.
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        streamResponse([
          'data: {"status":"progress","progress":5,"total":10}\n\ndata: {"status":"pro',
          'gress","progress":10,"total":10}\n\n',
          'data: {"status":"done","progress":10,"total":10}\n\n',
        ]),
      );
    const calls = await run();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/install_extension',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ id: 'mermaid' }) }),
    );
    expect(calls).toEqual({
      progress: [
        [5, 10],
        [10, 10],
      ],
      done: 1,
      errors: [],
    });
  });

  it('relays a server-side error event', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        streamResponse(['data: {"status":"error","progress":0,"total":0,"error":"Checksum"}\n\n']),
      );
    const calls = await run();
    expect(calls.done).toBe(0);
    expect(calls.errors).toEqual(['Checksum']);
  });

  it('reports a stream that ends without a verdict', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        streamResponse(['data: {"status":"progress","progress":1,"total":9}\n\n']),
      );
    const calls = await run();
    expect(calls.errors).toEqual(['Download interrupted']);
  });

  it('reports an HTTP failure instead of throwing', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const calls = await run();
    expect(calls.errors).toEqual(['Backend call failed: install_extension']);
  });
});

describe('dispatchDownloadEvent', () => {
  it('routes each status and says when the download ends', async () => {
    const { dispatchDownloadEvent } = await import('../backend.js');
    const onProgress = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();
    const d = (p) => dispatchDownloadEvent(p, onProgress, onDone, onError);
    expect(d({ status: 'progress', progress: 1, total: 2 })).toBe(false);
    expect(onProgress).toHaveBeenCalledWith(1, 2);
    expect(d({ status: 'unknown' })).toBe(false);
    expect(d(null)).toBe(false);
    expect(d({ status: 'done' })).toBe(true);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(d({ status: 'error' })).toBe(true);
    expect(onError.mock.calls[0][0].message).toBe('Download failed');
  });
});

describe('retryAfterSeconds', () => {
  it('parses delta-seconds and rejects junk', async () => {
    const { retryAfterSeconds } = await import('../backend.js');
    expect(retryAfterSeconds('900')).toBe(900);
    expect(retryAfterSeconds('0')).toBe(0);
    expect(retryAfterSeconds('1.2')).toBe(2);
    expect(retryAfterSeconds(null)).toBeNull();
    expect(retryAfterSeconds('')).toBeNull();
    expect(retryAfterSeconds('-5')).toBeNull();
    expect(retryAfterSeconds('Wed, 21 Oct 2015 07:28:00 GMT')).toBeNull();
  });
});

describe('bytesToBase64', () => {
  it('matches the standard encoding, including for large inputs', async () => {
    const { bytesToBase64 } = await import('../backend.js');
    expect(bytesToBase64([])).toBe('');
    expect(bytesToBase64([137, 80, 0, 255])).toBe('iVAA/w==');
    const big = new Uint8Array(200000).map((_, i) => i % 256);
    expect(bytesToBase64(big)).toBe(Buffer.from(big).toString('base64'));
  });
});
