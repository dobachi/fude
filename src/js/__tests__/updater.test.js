import { describe, it, expect } from 'vitest';
import { describeManualCheck, describeInstallError, isLinuxPlatform } from '../core/updater.js';

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
