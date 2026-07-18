import { describe, it, expect, vi } from 'vitest';
import {
  nextEnabledIndex,
  edgeEnabledIndex,
  menuIndexForAccessKey,
  createAltTap,
} from '../core/menu-nav.js';

const items = [{ label: 'a' }, { separator: true }, { label: 'b', disabled: true }, { label: 'c' }];

describe('nextEnabledIndex', () => {
  it('下へ動くとき区切りと無効項目を飛ばす', () => {
    expect(nextEnabledIndex(items, 0, 1)).toBe(3);
  });

  it('上へ動くときも飛ばす', () => {
    expect(nextEnabledIndex(items, 3, -1)).toBe(0);
  });

  it('末尾から下へ動くと先頭に回り込む', () => {
    expect(nextEnabledIndex(items, 3, 1)).toBe(0);
  });

  it('先頭から上へ動くと末尾に回り込む', () => {
    expect(nextEnabledIndex(items, 0, -1)).toBe(3);
  });

  it('未選択から下は先頭の有効項目', () => {
    expect(nextEnabledIndex(items, -1, 1)).toBe(0);
  });

  it('未選択から上は末尾の有効項目', () => {
    expect(nextEnabledIndex(items, -1, -1)).toBe(3);
  });

  it('選べる項目が無ければ -1', () => {
    expect(nextEnabledIndex([{ separator: true }, { disabled: true }], -1, 1)).toBe(-1);
  });

  it('空・不正入力でも壊れない', () => {
    expect(nextEnabledIndex([], 0, 1)).toBe(-1);
    expect(nextEnabledIndex(null, 0, 1)).toBe(-1);
  });

  it('有効項目が1つだけならそこに留まる', () => {
    const one = [{ separator: true }, { label: 'only' }];
    expect(nextEnabledIndex(one, 1, 1)).toBe(1);
    expect(nextEnabledIndex(one, 1, -1)).toBe(1);
  });

  it('範囲外の current を渡しても端から探す', () => {
    expect(nextEnabledIndex(items, 99, 1)).toBe(0);
  });
});

describe('edgeEnabledIndex', () => {
  it('Home は先頭の有効項目', () => {
    expect(edgeEnabledIndex(items, 'first')).toBe(0);
  });

  it('End は末尾の有効項目', () => {
    expect(edgeEnabledIndex(items, 'last')).toBe(3);
  });
});

describe('menuIndexForAccessKey', () => {
  const menus = [
    { label: 'ファイル(F)', accessKey: 'F' },
    { label: '編集(E)', accessKey: 'E' },
    { label: 'ヘルプ(H)', accessKey: 'H' },
  ];

  it('アクセスキーからメニューを引く', () => {
    expect(menuIndexForAccessKey(menus, 'E')).toBe(1);
  });

  it('大小を区別しない', () => {
    expect(menuIndexForAccessKey(menus, 'f')).toBe(0);
    expect(menuIndexForAccessKey(menus, 'h')).toBe(2);
  });

  it('該当が無ければ -1', () => {
    expect(menuIndexForAccessKey(menus, 'z')).toBe(-1);
  });

  it('accessKey を持たないメニューは無視する', () => {
    expect(menuIndexForAccessKey([{ label: 'x' }], 'x')).toBe(-1);
  });

  it('不正な入力では -1', () => {
    expect(menuIndexForAccessKey(menus, '')).toBe(-1);
    expect(menuIndexForAccessKey(menus, 'ff')).toBe(-1);
    expect(menuIndexForAccessKey(null, 'f')).toBe(-1);
  });
});

describe('createAltTap', () => {
  const key = (k, extra = {}) => ({ key: k, ...extra });

  it('Alt を押して離すと発火する', () => {
    const onTap = vi.fn();
    const t = createAltTap({ onTap });
    t.keydown(key('Alt'));
    t.keyup(key('Alt'));
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it('Alt+F のように他のキーを挟んだら発火しない', () => {
    // Emacs モードの M-f を奪わないための肝。ここが崩れると単押し方針が壊れる
    const onTap = vi.fn();
    const t = createAltTap({ onTap });
    t.keydown(key('Alt'));
    t.keydown(key('f', { altKey: true }));
    t.keyup(key('Alt'));
    expect(onTap).not.toHaveBeenCalled();
  });

  it('Alt を押しっぱなしのオートリピートでは武装し直さない', () => {
    const onTap = vi.fn();
    const t = createAltTap({ onTap });
    t.keydown(key('Alt'));
    t.keydown(key('x', { altKey: true }));
    t.keydown(key('Alt', { repeat: true }));
    t.keyup(key('Alt'));
    expect(onTap).not.toHaveBeenCalled();
  });

  it('Alt 以外の keyup では発火しない', () => {
    const onTap = vi.fn();
    const t = createAltTap({ onTap });
    t.keydown(key('Alt'));
    t.keyup(key('f'));
    expect(onTap).not.toHaveBeenCalled();
  });

  it('Alt を押さずに離しただけでは発火しない', () => {
    const onTap = vi.fn();
    const t = createAltTap({ onTap });
    t.keyup(key('Alt'));
    expect(onTap).not.toHaveBeenCalled();
  });

  it('reset で武装解除される（ウィンドウのフォーカスが外れた場合）', () => {
    const onTap = vi.fn();
    const t = createAltTap({ onTap });
    t.keydown(key('Alt'));
    t.reset();
    t.keyup(key('Alt'));
    expect(onTap).not.toHaveBeenCalled();
  });

  it('2回続けて単押しできる', () => {
    const onTap = vi.fn();
    const t = createAltTap({ onTap });
    t.keydown(key('Alt'));
    t.keyup(key('Alt'));
    t.keydown(key('Alt'));
    t.keyup(key('Alt'));
    expect(onTap).toHaveBeenCalledTimes(2);
  });
});
