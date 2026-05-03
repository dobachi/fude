// help.js - Keyboard shortcut help panel

let helpPanel = null;

const sections = [
  {
    title: '表示・レイアウト',
    items: [
      ['Ctrl+Shift+J', 'エディタのみ表示'],
      ['Ctrl+Shift+K', '分割表示'],
      ['Ctrl+Shift+L', 'プレビューのみ表示'],
      ['Ctrl+| / Ctrl+Shift+D', '縦分割'],
      ['Ctrl+\\ / Ctrl+Shift+H', '横分割'],
      ['Ctrl+Shift+W', 'タブ/ペインを閉じる（複数ペインならペイン優先）'],
      ['Ctrl+矢印', 'ペイン移動'],
      ['Ctrl+- / Ctrl++', '文字縮小 / 拡大'],
      ['Ctrl+Shift+E', 'サイドバー表示/非表示'],
    ],
  },
  {
    title: 'ファイル・タブ',
    items: [
      ['Ctrl+Shift+T / Ctrl+Shift+N', '新規タブ'],
      ['Ctrl+Tab', '次のタブ'],
      ['Ctrl+Shift+Tab', '前のタブ'],
      ['Ctrl+Shift+S', '保存（未保存ファイルは保存先を尋ねる）'],
      ['Ctrl+Alt+S', '名前を付けて保存'],
      ['Ctrl+Shift+O', 'フォルダを開く'],
      ['Ctrl+Shift+R', 'ファイルをディスクから再読込（外部変更を検知すると自動）'],
    ],
  },
  {
    title: '編集（Markdown）',
    items: [
      ['Ctrl+B', '太字トグル（Normal/Vim）'],
      ['Ctrl+Shift+8', '箇条書きトグル'],
      ['Ctrl+Shift+7', '番号付きリストトグル'],
      ['Ctrl+F', '検索・置換（Normal/Vim）'],
    ],
  },
  {
    title: 'AI',
    items: [
      ['Ctrl+I', 'AIチャットパネル切替（選択範囲をコンテキストに）'],
      ['Ctrl+Shift+I', 'AIコンポーザー（選択範囲を編集）'],
      ['Tab', 'インライン補完を受け入れる'],
      ['Esc', 'インライン補完を破棄'],
      ['右クリック', 'AIアクションメニュー（選択範囲が必要）'],
    ],
  },
  {
    title: 'キーモード',
    items: [
      ['Ctrl+Shift+M', 'モード切替（Normal → Vim → Emacs）'],
      ['設定パネル', 'モードを直接選択（Ctrl+,）'],
    ],
  },
  {
    title: 'Vimモード',
    items: [
      ['jj / jk', 'インサートモード解除（ESC代替）'],
      ['Ctrl+[', 'インサート/ビジュアル解除（ESC代替）'],
    ],
  },
  {
    title: 'Emacsモード（カーソル/編集）',
    items: [
      ['Ctrl+A / Ctrl+E', '行頭 / 行末'],
      ['Ctrl+B / Ctrl+F', '1文字前 / 後'],
      ['Ctrl+P / Ctrl+N', '前行 / 次行'],
      ['Ctrl+D / Ctrl+H', '次文字を削除 / 前文字を削除'],
      ['Ctrl+K / Ctrl+Y', '行末までキル / ヤンク（貼り付け）'],
      ['Ctrl+W / Alt+W', '領域をキル / コピー'],
      ['Ctrl+S / Ctrl+R', 'インクリメンタル検索 / 逆検索'],
      ['Alt+B / Alt+F', '単語前 / 後'],
      ['Alt+V / Ctrl+V', 'ページ前 / 後'],
    ],
  },
  {
    title: 'その他',
    items: [
      ['Ctrl+,', '設定'],
      ['Ctrl+?', 'このヘルプ'],
    ],
  },
  {
    title: 'ブラウザモード用',
    items: [
      ['Alt+N / Alt+T', '新規タブ'],
      ['Alt+W', 'タブ/ペインを閉じる'],
      ['Alt+O', 'フォルダを開く'],
    ],
  },
];

export function openHelp() {
  if (helpPanel) return;

  helpPanel = document.createElement('div');
  helpPanel.className = 'help-overlay';

  const sectionsHtml = sections
    .map(({ title, items }) => {
      const rows = items
        .map(([key, desc]) => `<tr><td><kbd>${key}</kbd></td><td>${desc}</td></tr>`)
        .join('');
      return `<section class="help-section"><h3>${title}</h3><table><tbody>${rows}</tbody></table></section>`;
    })
    .join('');

  helpPanel.innerHTML = `
    <div class="help-panel">
      <div class="help-header">
        <h2>Keyboard Shortcuts</h2>
        <button class="help-close icon-btn">\u00d7</button>
      </div>
      <div class="help-body">
        ${sectionsHtml}
      </div>
    </div>
  `;

  document.body.appendChild(helpPanel);

  helpPanel.querySelector('.help-close').addEventListener('click', closeHelp);
  helpPanel.addEventListener('click', (e) => {
    if (e.target === helpPanel) closeHelp();
  });

  const handleEsc = (e) => {
    if (e.key === 'Escape') {
      closeHelp();
      document.removeEventListener('keydown', handleEsc);
    }
  };
  document.addEventListener('keydown', handleEsc);
}

export function closeHelp() {
  if (helpPanel) {
    helpPanel.remove();
    helpPanel = null;
  }
}
