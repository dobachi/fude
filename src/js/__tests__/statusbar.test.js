import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  toVaultRelative,
  truncatePath,
  statusPathText,
  createStatusBar,
  DEFAULT_MAX_LEN,
} from '../core/statusbar.js';

describe('toVaultRelative', () => {
  it('vault 配下なら相対パスにする', () => {
    expect(toVaultRelative('/home/me/notes/projects/a.md', '/home/me/notes')).toBe('projects/a.md');
    // 末尾スラッシュ付きの vault でも同じ結果
    expect(toVaultRelative('/home/me/notes/a.md', '/home/me/notes/')).toBe('a.md');
  });

  it('vault 配下でなければ絶対パスのまま', () => {
    expect(toVaultRelative('/tmp/other/a.md', '/home/me/notes')).toBe('/tmp/other/a.md');
  });

  it('vault 未設定なら元のパスのまま', () => {
    expect(toVaultRelative('/home/me/a.md', '')).toBe('/home/me/a.md');
    expect(toVaultRelative('/home/me/a.md', null)).toBe('/home/me/a.md');
  });

  it('Windows パスでも動く', () => {
    expect(toVaultRelative('C:\\notes\\projects\\a.md', 'C:\\notes')).toBe('projects\\a.md');
  });

  it('vault 自身を指す場合は空にせず元のパスを返す', () => {
    expect(toVaultRelative('/home/me/notes', '/home/me/notes')).toBe('/home/me/notes');
  });

  it('空入力で落ちない', () => {
    expect(toVaultRelative('', '/home/me')).toBe('');
    expect(toVaultRelative(null, '/home/me')).toBe('');
  });
});

describe('truncatePath', () => {
  it('短ければそのまま', () => {
    expect(truncatePath('projects/a.md', 40)).toBe('projects/a.md');
  });

  it('長いときは先頭側を畳み、ファイル名は必ず残す', () => {
    const p = '/very/long/path/that/keeps/going/deeper/and/deeper/README.md';
    const got = truncatePath(p, 30);
    expect(got.length).toBeLessThanOrEqual(30);
    expect(got.startsWith('…/')).toBe(true);
    expect(got.endsWith('README.md')).toBe(true);
  });

  it('セグメント境界で切る（ディレクトリ名の途中で切らない）', () => {
    const full = '/aaaa/bbbb/cccc/dddd/eeee/name.md';
    const got = truncatePath(full, 22);
    const kept = got.replace(/^…\//, '');
    // 残した部分は元パスの末尾そのもので、かつ境界が "/" で揃っている
    expect(full.endsWith(kept)).toBe(true);
    expect(full.endsWith('/' + kept)).toBe(true);
    expect(got.length).toBeLessThanOrEqual(22);
  });

  it('ファイル名だけでも収まらないならファイル名を返す', () => {
    const long = 'a'.repeat(50) + '.md';
    expect(truncatePath('/x/y/' + long, 20)).toBe(long);
  });

  it('Windows パスでは区切りを \\ のまま保つ', () => {
    const got = truncatePath('C:\\aaaa\\bbbb\\cccc\\dddd\\eeee\\name.md', 24);
    expect(got.startsWith('…\\')).toBe(true);
    expect(got).not.toContain('/');
  });

  it('空入力で落ちない', () => {
    expect(truncatePath('', 10)).toBe('');
    expect(truncatePath(null, 10)).toBe('');
  });
});

describe('statusPathText', () => {
  it('相対化してから省略する', () => {
    expect(statusPathText('/home/me/notes/projects/a.md', '/home/me/notes')).toBe('projects/a.md');
  });

  it('ファイル未選択なら空文字', () => {
    expect(statusPathText(null, '/home/me')).toBe('');
    expect(statusPathText('', '/home/me')).toBe('');
  });

  it('maxLen を指定できる（既定値も持つ）', () => {
    const p = '/home/me/notes/' + 'x/'.repeat(60) + 'a.md';
    expect(statusPathText(p, '', { maxLen: 20 }).length).toBeLessThanOrEqual(20);
    expect(statusPathText(p, '').length).toBeLessThanOrEqual(DEFAULT_MAX_LEN);
  });
});

describe('createStatusBar', () => {
  let el;

  beforeEach(() => {
    document.body.innerHTML = `<div id="status-bar"><span class="status-path"></span></div>`;
    el = document.getElementById('status-bar');
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  const pathEl = () => document.querySelector('.status-path');

  it('パスを描画し、ツールチップにはフルパスを入れる', () => {
    const bar = createStatusBar({ el, getVaultPath: () => '/home/me/notes' });
    bar.render('/home/me/notes/projects/a.md');
    expect(pathEl().textContent).toBe('projects/a.md');
    expect(pathEl().title).toBe('/home/me/notes/projects/a.md');
    expect(pathEl().classList.contains('is-empty')).toBe(false);
    expect(bar.getPath()).toBe('/home/me/notes/projects/a.md');
  });

  it('ファイル未選択なら案内を出し、is-empty を付ける', () => {
    const bar = createStatusBar({ el, getVaultPath: () => '' });
    bar.render(null);
    expect(pathEl().textContent).toContain('開かれていません');
    expect(pathEl().title).toBe('');
    expect(pathEl().classList.contains('is-empty')).toBe(true);
    expect(bar.getPath()).toBeNull();
  });

  it('生成直後は未選択状態で描画される', () => {
    createStatusBar({ el });
    expect(pathEl().classList.contains('is-empty')).toBe(true);
  });

  it('引数なしの render は vault 変更後の再描画に使える', () => {
    let vault = '';
    const bar = createStatusBar({ el, getVaultPath: () => vault });
    bar.render('/home/me/notes/a.md');
    expect(pathEl().textContent).toBe('/home/me/notes/a.md');

    vault = '/home/me/notes'; // ここでフォルダを開いた想定
    bar.render();
    expect(pathEl().textContent).toBe('a.md');
    expect(bar.getPath()).toBe('/home/me/notes/a.md'); // 保持しているのはフルパス
  });

  it('クリックでフルパスをコピーし、コールバックを呼ぶ', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const onCopy = vi.fn();
    const bar = createStatusBar({ el, getVaultPath: () => '/home/me/notes', onCopy });
    bar.render('/home/me/notes/projects/a.md');

    const ok = await bar.copy();
    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith('/home/me/notes/projects/a.md');
    expect(onCopy).toHaveBeenCalledWith('/home/me/notes/projects/a.md');
  });

  it('未選択ならコピーしない', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const bar = createStatusBar({ el });
    expect(await bar.copy()).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('クリップボードが失敗しても例外を投げない', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    const bar = createStatusBar({ el });
    bar.render('/home/me/a.md');
    expect(await bar.copy()).toBe(false);
  });

  it('要素が無くても落ちない（Tauri 不在のテスト環境など）', () => {
    const bar = createStatusBar({ el: null });
    expect(() => bar.render('/home/me/a.md')).not.toThrow();
    expect(bar.getPath()).toBe('/home/me/a.md');
  });
});
