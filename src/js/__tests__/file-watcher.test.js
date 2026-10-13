import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The vault watch: which folder the host is asked to watch as the open folder
// changes, and how its `directory-changed` reports become one tree refresh.

const backend = {
  isLocalTauri: vi.fn(() => true),
  watchDirectory: vi.fn(),
  unwatchDirectory: vi.fn(),
  watchFile: vi.fn(),
  unwatchFile: vi.fn(),
  readFile: vi.fn(),
};
vi.mock('../backend.js', () => backend);
vi.mock('../core/editor.js', () => ({ setContentFromDisk: vi.fn() }));

const listeners = {};
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name, fn) => {
    listeners[name] = fn;
  }),
}));

const REMOTE = 'remote://k16/home/u/notes';

describe('file-watcher: フォルダの監視', () => {
  let fw;

  beforeEach(async () => {
    vi.resetModules();
    for (const k of Object.keys(listeners)) delete listeners[k];
    backend.isLocalTauri.mockReset().mockReturnValue(true);
    backend.watchDirectory.mockReset().mockResolvedValue(undefined);
    backend.unwatchDirectory.mockReset().mockResolvedValue(undefined);
    fw = await import('../core/file-watcher.js');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('リモートのフォルダも監視を頼む', async () => {
    await fw.watchVault(REMOTE);
    expect(backend.watchDirectory).toHaveBeenCalledWith(REMOTE);
    expect(backend.unwatchDirectory).not.toHaveBeenCalled();
  });

  it('同じフォルダをもう一度指定しても頼み直さない', async () => {
    await fw.watchVault(REMOTE);
    await fw.watchVault(REMOTE);
    expect(backend.watchDirectory).toHaveBeenCalledTimes(1);
  });

  it('フォルダが替わると前のものを外してから新しいものを頼む', async () => {
    await fw.watchVault('/home/u/a');
    await fw.watchVault(REMOTE);
    expect(backend.unwatchDirectory).toHaveBeenCalledWith('/home/u/a');
    expect(backend.watchDirectory).toHaveBeenLastCalledWith(REMOTE);
    expect(backend.unwatchDirectory.mock.invocationCallOrder[0]).toBeLessThan(
      backend.watchDirectory.mock.invocationCallOrder[1],
    );

    await fw.watchVault('');
    expect(backend.unwatchDirectory).toHaveBeenLastCalledWith(REMOTE);
    expect(backend.watchDirectory).toHaveBeenCalledTimes(2);
  });

  it('監視を頼めなくても例外にしない（古い fude-cli など）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    backend.watchDirectory.mockRejectedValue(new Error('timeout'));
    await expect(fw.watchVault(REMOTE)).resolves.toBeUndefined();
    backend.unwatchDirectory.mockRejectedValue(new Error('no agent'));
    await expect(fw.watchVault('/home/u/a')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('ブラウザモードでは何もしない', async () => {
    backend.isLocalTauri.mockReturnValue(false);
    await fw.watchVault(REMOTE);
    expect(backend.watchDirectory).not.toHaveBeenCalled();
  });

  describe('接続が切れたとき', () => {
    it('そのホストのフォルダは、開き直すと新しい接続に頼み直す', async () => {
      await fw.watchVault(REMOTE);
      fw.vaultHostLost('k16');
      await fw.watchVault(REMOTE);
      expect(backend.watchDirectory).toHaveBeenCalledTimes(2);
      // The old agent is gone: there is nothing to release.
      expect(backend.unwatchDirectory).not.toHaveBeenCalled();
    });

    it('別のホストやローカルのフォルダの監視は忘れない', async () => {
      await fw.watchVault(REMOTE);
      fw.vaultHostLost('other');
      fw.vaultHostLost('');
      fw.vaultHostLost(undefined);
      await fw.watchVault(REMOTE);
      expect(backend.watchDirectory).toHaveBeenCalledTimes(1);

      await fw.watchVault('/home/u/k16');
      fw.vaultHostLost('k16');
      await fw.watchVault('/home/u/k16');
      expect(backend.watchDirectory).toHaveBeenCalledTimes(2);
    });

    it('何も開いていなければ何もしない', () => {
      expect(() => fw.vaultHostLost('k16')).not.toThrow();
    });
  });

  describe('directory-changed', () => {
    it('立て続けの通知は 1 回の更新にまとめる', async () => {
      vi.useFakeTimers();
      const refresh = vi.fn();
      await fw.initDirectoryWatcher(refresh);
      const fire = listeners['directory-changed'];
      expect(fire).toBeTypeOf('function');

      fire({ payload: { path: REMOTE } });
      vi.advanceTimersByTime(150);
      fire({ payload: { path: REMOTE } });
      vi.advanceTimersByTime(199);
      expect(refresh).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(refresh).toHaveBeenCalledTimes(1);

      fire({ payload: { path: REMOTE } });
      vi.advanceTimersByTime(200);
      expect(refresh).toHaveBeenCalledTimes(2);
    });

    it('ブラウザモードでは購読しない', async () => {
      backend.isLocalTauri.mockReturnValue(false);
      await fw.initDirectoryWatcher(vi.fn());
      expect(listeners['directory-changed']).toBeUndefined();
    });
  });
});
