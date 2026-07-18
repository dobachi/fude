// menu-nav.js - メニューのキーボード操作に使う純粋な計算。
//
// DOM を持たない index 計算だけを切り出してあるので、そのまま単体テストできる。

/**
 * 次に選ぶ項目の index を返す。無効な項目（disabled / separator）は飛ばし、
 * 端まで来たら反対側へ回り込む。
 *
 * @param {Array<{separator?: boolean, disabled?: boolean}>} items
 * @param {number} current 現在の index（未選択なら -1）
 * @param {number} step +1 で下、-1 で上
 * @returns {number} 次の index。選べる項目が無ければ -1
 */
export function nextEnabledIndex(items, current, step) {
  if (!Array.isArray(items) || items.length === 0) return -1;
  const selectable = (it) => it && !it.separator && !it.disabled;
  if (!items.some(selectable)) return -1;

  // 未選択から上へ動いたときは末尾から始める（下なら先頭から）
  let i = current;
  if (i < 0 || i >= items.length) i = step > 0 ? -1 : items.length;

  for (let n = 0; n < items.length; n++) {
    i = (i + step + items.length) % items.length;
    if (selectable(items[i])) return i;
  }
  return -1;
}

/** 先頭 / 末尾の選択可能な項目（Home / End 用） */
export function edgeEnabledIndex(items, edge) {
  return edge === 'last' ? nextEnabledIndex(items, 0, -1) : nextEnabledIndex(items, -1, 1);
}

/**
 * アクセスキー（Alt+文字）に対応するメニューの index を返す。
 * 大小は区別しない。見つからなければ -1。
 *
 * @param {Array<{accessKey?: string}>} menus
 * @param {string} key 押された文字
 */
export function menuIndexForAccessKey(menus, key) {
  if (!Array.isArray(menus) || typeof key !== 'string' || key.length !== 1) return -1;
  const want = key.toLowerCase();
  return menus.findIndex(
    (m) => typeof m.accessKey === 'string' && m.accessKey.toLowerCase() === want,
  );
}

/**
 * Alt の「単押し」を検出する小さな状態機械。
 *
 * Windows のメニューバーと同じで、Alt を押して**他のキーを挟まずに**離した
 * ときだけメニューバーを開きたい。Alt+F のような組み合わせや、Alt を押した
 * まま別のキーを打った場合は開かない。
 *
 * @param {{onTap: () => void}} opts
 */
export function createAltTap({ onTap }) {
  let armed = false;

  return {
    keydown(e) {
      if (e.key === 'Alt') {
        // Alt の押しっぱなし（オートリピート）で武装し直さない
        if (!e.repeat) armed = true;
        return;
      }
      // Alt 以外が押されたら単押しではない
      armed = false;
    },
    keyup(e) {
      if (e.key !== 'Alt') return;
      if (!armed) return;
      armed = false;
      onTap();
    },
    /** ウィンドウのフォーカスが外れた等でリセットする */
    reset() {
      armed = false;
    },
    isArmed() {
      return armed;
    },
  };
}
