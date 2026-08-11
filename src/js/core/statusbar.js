// statusbar.js - 画面下部のステータスバー。現在開いているファイルのパスを常時表示する。
//
// 表示テキストの決定（vault 相対化・省略）は純粋関数に切り出し、DOM に触るのは
// createStatusBar が返すコントローラだけにしてある。テストは純粋関数側で行う。
//
// パスは末尾（ファイル名）が最も重要なので、省略は**先頭側**を削る。
// CSS の text-overflow に任せると末尾が消えてファイル名が見えなくなるため。
//
// vault 相対にしたものは "./" 始まりで示す。無印だと vault 直下のファイルが
// 「ファイル名だけ」の表示になり、パスが出ていないように見えるため。
// フルパスは title（ツールチップ）とクリックでのコピーで常に取り出せる。

import { canonicalPath } from './pathnorm.js';

/** 既定の最大表示文字数。これを超えると先頭のディレクトリから畳む。 */
export const DEFAULT_MAX_LEN = 90;

const EMPTY_TEXT = 'ファイルが開かれていません';

/**
 * vault（開いているフォルダ）配下なら vault 相対パスにする。
 * 配下でない・vault 未設定なら元のパスをそのまま返す。
 *
 * @param {string} filePath
 * @param {string} vaultPath
 * @returns {string}
 */
export function toVaultRelative(filePath, vaultPath) {
  const p = String(filePath ?? '');
  const v = String(vaultPath ?? '');
  if (!p || !v) return p;
  // 比較は WSL の UNC 別名（\\wsl$ ⇄ \\wsl.localhost）を吸収した形で行う。
  // 切り出すのは末尾側なので、正規化した文字列から取っても中身は変わらない。
  const cp = canonicalPath(p);
  const base = canonicalPath(v).replace(/[/\\]+$/, '');
  if (!base) return p;
  if (!cp.startsWith(base)) return p;
  const tail = cp.slice(base.length);
  // 境界が区切り文字であることまで見る。単なる前置一致だと
  // vault=/a/notes に対して /a/notes-old/x.md まで配下扱いしてしまう。
  if (tail && !/^[/\\]/.test(tail)) return p;
  const rest = tail.replace(/^[/\\]+/, '');
  // vault 自身を指していた場合は畳まない（空文字にしない）
  return rest || p;
}

/** 区切り文字は元のパスの流儀に合わせる（Windows パスを / に書き換えない）。 */
function separatorOf(path) {
  const p = String(path ?? '');
  return p.includes('\\') && !p.includes('/') ? '\\' : '/';
}

/**
 * 長いパスを先頭側から畳んで maxLen 以内にする。ファイル名は必ず残す。
 * 畳んだ場合は先頭に "…/" が付く。
 *
 * @param {string} path
 * @param {number} [maxLen]
 * @returns {string}
 */
export function truncatePath(path, maxLen = DEFAULT_MAX_LEN) {
  const p = String(path ?? '');
  if (!p || p.length <= maxLen) return p;

  const sep = separatorOf(p);
  const segments = p.split(/[/\\]/);
  const name = segments[segments.length - 1];

  // ファイル名だけでも収まらないなら、それ以上削れないのでそのまま出す
  if (name.length + 2 >= maxLen) return name;

  // 末尾から 1 セグメントずつ足していき、収まる最大の範囲を採用する
  let kept = name;
  for (let i = segments.length - 2; i >= 0; i--) {
    const next = segments[i] + sep + kept;
    if (next.length + 2 > maxLen) break;
    kept = next;
  }
  return '…' + sep + kept;
}

/**
 * ステータスバーに出す表示用テキスト。ファイル未選択なら空文字。
 *
 * vault 相対にしたときは "./"（Windows パスなら ".\"）を前置する。付けないと
 * vault 直下のファイルが「ファイル名だけ」になり、絶対パスの短縮なのか相対なのか
 * 区別が付かない。省略が起きる場合は先頭の "." ごと "…" に畳まれる。
 * フルパスはツールチップ（title）とクリックでのコピーで取り出せる。
 *
 * @param {string|null} filePath
 * @param {string} vaultPath
 * @param {{maxLen?: number}} [opts]
 * @returns {string}
 */
export function statusPathText(filePath, vaultPath, opts = {}) {
  if (!filePath) return '';
  const maxLen = opts.maxLen ?? DEFAULT_MAX_LEN;
  const rel = toVaultRelative(filePath, vaultPath);
  const shown = rel === filePath ? rel : '.' + separatorOf(filePath) + rel;
  return truncatePath(shown, maxLen);
}

/**
 * ステータスバーのコントローラ。
 *
 * @param {{
 *   el: HTMLElement|null,
 *   getVaultPath?: () => string,
 *   onCopy?: (path: string) => void,
 *   maxLen?: number,
 * }} deps
 */
export function createStatusBar(deps = {}) {
  const { el, getVaultPath = () => '', onCopy, maxLen } = deps;
  let currentPath = null;

  const pathEl = el ? el.querySelector('.status-path') : null;

  function render(filePath = currentPath) {
    currentPath = filePath || null;
    if (!pathEl) return;
    const text = statusPathText(currentPath, getVaultPath(), { maxLen });
    pathEl.textContent = text || EMPTY_TEXT;
    // 省略しても全体が分かるよう、ツールチップには常にフルパスを出す
    pathEl.title = currentPath || '';
    pathEl.classList.toggle('is-empty', !currentPath);
  }

  async function copy() {
    if (!currentPath) return false;
    try {
      await navigator.clipboard.writeText(currentPath);
      if (onCopy) onCopy(currentPath);
      return true;
    } catch {
      return false;
    }
  }

  if (pathEl) {
    // クリックでフルパスをコピー（省略表示でも取り出せるように）
    pathEl.addEventListener('click', () => {
      copy();
    });
  }

  render(null);

  return {
    /** 表示を更新する。引数省略で現在のパスのまま再描画（vault 変更時など）。 */
    render,
    /** 現在表示中のフルパス（未選択は null）。 */
    getPath: () => currentPath,
    /** フルパスをクリップボードへ。成功したら true。 */
    copy,
  };
}
