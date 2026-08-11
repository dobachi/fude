import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  describeManualCheck,
  describeInstallPlan,
  describeInstallError,
  isLinuxPlatform,
  checkForUpdates,
} from '../core/updater.js';

describe('describeManualCheck', () => {
  it('reports unsupported (browser) mode as an error', () => {
    const r = describeManualCheck({ isDesktop: false, update: null, error: null });
    expect(r.kind).toBe('unsupported');
    expect(r.type).toBe('error');
    expect(r.message).toContain('デスクトップ版');
  });

  it('reports an available update with its version', () => {
    const r = describeManualCheck({ isDesktop: true, update: { version: '0.4.29' }, error: null });
    expect(r.kind).toBe('update');
    expect(r.version).toBe('0.4.29');
  });

  it('reports up-to-date when no update and no error', () => {
    const r = describeManualCheck({ isDesktop: true, update: null, error: null });
    expect(r.kind).toBe('latest');
    expect(r.type).toBe('info');
    expect(r.message).toContain('最新');
  });

  it('reports the error message when the check failed', () => {
    const r = describeManualCheck({ isDesktop: true, update: null, error: 'network down' });
    expect(r.kind).toBe('error');
    expect(r.type).toBe('error');
    expect(r.message).toContain('network down');
  });

  it('prioritizes the unsupported case even if an error is present', () => {
    const r = describeManualCheck({ isDesktop: false, update: null, error: 'boom' });
    expect(r.kind).toBe('unsupported');
  });
});

describe('describeInstallError', () => {
  it('エラーメッセージをそのまま詳細として返す', () => {
    const r = describeInstallError(new Error('exit code 127'));
    expect(r.detail).toBe('exit code 127');
  });

  it('message を持たない値も文字列化する', () => {
    expect(describeInstallError('boom').detail).toBe('boom');
    expect(describeInstallError(null).detail).toBe('不明なエラー');
    expect(describeInstallError(undefined).detail).toBe('不明なエラー');
  });

  // WSL の deb 版では pkexec が認証できず、アプリ内更新は構造的に成功しない。
  // 「再試行してください」だけを出すと永久に解決しないので、手動更新へ誘導する。
  it('Linux では管理者権限と手動更新に触れる', () => {
    const r = describeInstallError(new Error('x'), { isLinux: true });
    expect(r.hint).toContain('管理者権限');
    expect(r.hint).toContain('手動');
  });

  it('Linux 以外では再試行と手動更新を案内する', () => {
    const r = describeInstallError(new Error('x'), { isLinux: false });
    expect(r.hint).toContain('再試行');
    expect(r.hint).not.toContain('WSL');
  });

  it('既定は Linux 以外の文言', () => {
    expect(describeInstallError(new Error('x')).hint).toContain('再試行');
  });
});

describe('isLinuxPlatform', () => {
  it('Linux を判定する', () => {
    expect(isLinuxPlatform({ platform: 'Linux x86_64', userAgent: 'X11; Linux' })).toBe(true);
  });

  it('Android は Linux 扱いしない', () => {
    expect(isLinuxPlatform({ platform: 'Linux armv8l', userAgent: 'Android 14' })).toBe(false);
  });

  it('Windows / macOS は false', () => {
    expect(isLinuxPlatform({ platform: 'Win32', userAgent: 'Windows NT' })).toBe(false);
    expect(isLinuxPlatform({ platform: 'MacIntel', userAgent: 'Macintosh' })).toBe(false);
  });

  it('navigator が無くても壊れない', () => {
    expect(isLinuxPlatform(null)).toBe(false);
  });
});

describe('describeInstallPlan', () => {
  it('判定できないときはアプリ内更新のまま', () => {
    expect(describeInstallPlan(null).mode).toBe('in-app');
    expect(describeInstallPlan().label).toBe('アップデート');
    expect(describeInstallPlan(null).note).toBe('');
  });

  it('アプリ内更新が可能なら従来どおり', () => {
    expect(describeInstallPlan({ needs_root: true, no_auth: false, can_install: true }).mode).toBe(
      'in-app',
    );
  });

  // WSL の deb 版では pkexec（コンソール）と zenity（GUI）の両方でパスワードを
  // 聞かれた末に必ず失敗する。試させないことが目的。
  it('アプリ内更新が不可能なら手動更新へ誘導する', () => {
    const plan = describeInstallPlan({ needs_root: true, no_auth: true, can_install: false });
    expect(plan.mode).toBe('manual');
    expect(plan.label).toContain('リリースページ');
    expect(plan.note).toContain('管理者権限');
  });
});

// The dialog is only reachable through checkForUpdates, so fake the Tauri runtime
// and stub the plugins it imports dynamically.
vi.mock('@tauri-apps/plugin-updater', () => ({ check: () => Promise.resolve(mockUpdate) }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: () => Promise.resolve(mockRelaunch()) }));
vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: (url) => Promise.resolve(mockOpenUrl(url)),
}));

let mockUpdate = null;
let mockRelaunch = vi.fn();
let mockOpenUrl = vi.fn();
/** update_env command result. null = undecidable (fall back to the in-app update) */
let mockEnv = null;

function fakeTauri() {
  window.isTauri = true;
  window.__TAURI_INTERNALS__ = {
    invoke: vi.fn(async (cmd) => (cmd === 'update_env' ? mockEnv : null)),
  };
}

describe('更新ダイアログ', () => {
  beforeEach(() => {
    mockEnv = null;
    fakeTauri();
    mockRelaunch = vi.fn();
    mockOpenUrl = vi.fn();
    mockUpdate = {
      version: '0.9.9',
      body: 'リリースノート本文',
      downloadAndInstall: vi.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    delete window.isTauri;
    delete window.__TAURI_INTERNALS__;
    document.body.innerHTML = '';
  });

  it('更新があればダイアログを出す', async () => {
    await checkForUpdates();
    const overlay = document.querySelector('.settings-overlay');
    expect(overlay).toBeTruthy();
    expect(overlay.textContent).toContain('0.9.9');
    expect(overlay.textContent).toContain('リリースノート本文');
  });

  it('スキップで閉じ、インストールしない', async () => {
    await checkForUpdates();
    document.querySelector('.btn-skip').click();
    expect(document.querySelector('.settings-overlay')).toBeNull();
    expect(mockUpdate.downloadAndInstall).not.toHaveBeenCalled();
  });

  it('アップデートでインストールし再起動する', async () => {
    await checkForUpdates();
    document.querySelector('.btn-update').click();
    await vi.waitFor(() => expect(mockRelaunch).toHaveBeenCalled());
    expect(mockUpdate.downloadAndInstall).toHaveBeenCalled();
  });

  it('失敗したら理由を出したまま閉じず、リリースページへ誘導する', async () => {
    mockUpdate.downloadAndInstall = vi.fn().mockRejectedValue(new Error('disk full'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await checkForUpdates();
    document.querySelector('.btn-update').click();
    await vi.waitFor(() => expect(document.querySelector('.update-error-detail')).toBeTruthy());
    expect(document.querySelector('.update-error-detail').textContent).toContain('disk full');
    expect(mockRelaunch).not.toHaveBeenCalled();
    document.querySelector('.btn-release').click();
    await vi.waitFor(() => expect(mockOpenUrl).toHaveBeenCalled());
    expect(mockOpenUrl.mock.calls[0][0]).toContain('/releases');
    err.mockRestore();
  });

  it('エラーメッセージの markup をエスケープする', async () => {
    mockUpdate.downloadAndInstall = vi.fn().mockRejectedValue(new Error('<img src=x>'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await checkForUpdates();
    document.querySelector('.btn-update').click();
    await vi.waitFor(() => expect(document.querySelector('.update-error-detail')).toBeTruthy());
    expect(document.querySelector('.update-error-detail').querySelector('img')).toBeNull();
    err.mockRestore();
  });
});

describe('更新ダイアログ（アプリ内更新が不可能な環境）', () => {
  beforeEach(() => {
    mockEnv = { needs_root: true, no_auth: true, can_install: false };
    fakeTauri();
    mockRelaunch = vi.fn();
    mockOpenUrl = vi.fn();
    mockUpdate = {
      version: '0.9.9',
      body: 'リリースノート本文',
      downloadAndInstall: vi.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    delete window.isTauri;
    delete window.__TAURI_INTERNALS__;
    document.body.innerHTML = '';
  });

  it('理由を添えて手動更新のボタンに差し替える', async () => {
    await checkForUpdates();
    expect(document.querySelector('.btn-update').textContent).toContain('リリースページ');
    expect(document.querySelector('.update-note').textContent).toContain('管理者権限');
  });

  it('押してもインストールは走らせず、リリースページを開く', async () => {
    await checkForUpdates();
    document.querySelector('.btn-update').click();
    await vi.waitFor(() => expect(mockOpenUrl).toHaveBeenCalled());
    expect(mockUpdate.downloadAndInstall).not.toHaveBeenCalled();
    expect(mockRelaunch).not.toHaveBeenCalled();
    expect(document.querySelector('.settings-overlay')).toBeNull();
  });
});
