// help.js - Keyboard shortcut help panel

let helpPanel = null;

const sections = [
  {
    title: '表示・レイアウト',
    items: [
      ['Ctrl+J', 'エディタのみ表示'],
      ['Ctrl+K', '分割表示'],
      ['Ctrl+L', 'プレビューのみ表示'],
      ['Ctrl+| / Ctrl+Shift+D', '縦分割'],
      ['Ctrl+\\ / Ctrl+Shift+H', '横分割'],
      ['Ctrl+Shift+W', '分割ペインを閉じる'],
      ['Ctrl+矢印', 'ペイン移動'],
      ['Ctrl+- / Ctrl++', '文字縮小 / 拡大'],
      ['Ctrl+E', 'サイドバー表示/非表示'],
    ],
  },
  {
    title: 'ファイル・タブ',
    items: [
      ['Ctrl+T', '新規タブ'],
      ['Ctrl+N', '新規ファイル'],
      ['Ctrl+W', 'タブを閉じる'],
      ['Ctrl+Tab', '次のタブ'],
      ['Ctrl+Shift+Tab', '前のタブ'],
      ['Ctrl+S', '保存'],
      ['Ctrl+Shift+S', '名前を付けて保存'],
      ['Ctrl+O', 'フォルダを開く'],
    ],
  },
  {
    title: '編集',
    items: [
      ['Ctrl+B', '太字トグル'],
      ['Ctrl+Shift+8', '箇条書きトグル'],
      ['Ctrl+Shift+7', '番号付きリストトグル'],
      ['Ctrl+F', '検索・置換'],
    ],
  },
  {
    title: 'モード・その他',
    items: [
      ['Ctrl+Shift+M', 'Vimモード切替'],
      ['jj / jk', 'Vimインサートモード解除（ESC代替）'],
      ['Ctrl+,', '設定'],
      ['Ctrl+?', 'このヘルプ'],
    ],
  },
  {
    title: 'ブラウザモード用',
    items: [
      ['Alt+N / Alt+T', '新規ファイル'],
      ['Alt+W', 'タブを閉じる'],
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
