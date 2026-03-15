// help.js - Keyboard shortcut help panel

let helpPanel = null;

const shortcuts = [
  ['Ctrl+J', 'エディタのみ表示'],
  ['Ctrl+K', '分割表示'],
  ['Ctrl+L', 'プレビューのみ表示'],
  ['Ctrl+T', '新規タブ'],
  ['Ctrl+N', '新規ファイル'],
  ['Ctrl+W', 'タブを閉じる'],
  ['Ctrl+Tab', '次のタブ'],
  ['Ctrl+Shift+Tab', '前のタブ'],
  ['Ctrl+S', '保存'],
  ['Ctrl+Shift+S', '名前を付けて保存'],
  ['Ctrl+O', 'フォルダを開く'],
  ['Ctrl+B', '太字トグル'],
  ['Ctrl+E', 'サイドバー表示/非表示'],
  ['Ctrl+F', '検索・置換'],
  ['Ctrl+| / Ctrl+Shift+D', '縦分割'],
  ['Ctrl+\\ / Ctrl+Shift+H', '横分割'],
  ['Ctrl+Shift+W', '分割ペインを閉じる'],
  ['Ctrl+矢印', 'ペイン移動'],
  ['Ctrl+-', '文字縮小'],
  ['Ctrl++', '文字拡大'],
  ['Ctrl+Shift+M', 'Vimモード切替'],
  ['jj / jk', 'Vimインサートモード解除（ESC代替）'],
  ['Ctrl+,', '設定'],
  ['Ctrl+?', 'このヘルプ'],
  ['', ''],
  ['Alt+N / Alt+T', '新規ファイル（ブラウザモード用）'],
  ['Alt+W', 'タブを閉じる（ブラウザモード用）'],
  ['Alt+O', 'フォルダを開く（ブラウザモード用）'],
];

export function openHelp() {
  if (helpPanel) return;

  helpPanel = document.createElement('div');
  helpPanel.className = 'help-overlay';

  const rows = shortcuts
    .map(([key, desc]) => `<tr><td><kbd>${key}</kbd></td><td>${desc}</td></tr>`)
    .join('');

  helpPanel.innerHTML = `
    <div class="help-panel">
      <div class="help-header">
        <h2>Keyboard Shortcuts</h2>
        <button class="help-close icon-btn">\u00d7</button>
      </div>
      <div class="help-body">
        <table>
          <thead><tr><th>Key</th><th>Action</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
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
