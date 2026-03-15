// file-save-picker.js - Save file dialog for browser/remote mode
import * as backend from './backend.js';

export function openSavePicker(defaultPath, onSelect) {
  const overlay = document.createElement('div');
  overlay.className = 'settings-overlay';
  overlay.innerHTML = `
    <div class="settings-panel" style="width:500px;max-height:70vh;display:flex;flex-direction:column">
      <div class="settings-header">
        <h2>名前を付けて保存</h2>
        <button class="fp-close icon-btn">\u00d7</button>
      </div>
      <div class="fp-path-bar" style="padding:8px 16px;border-bottom:1px solid var(--border);display:flex;gap:8px;align-items:center">
        <button class="fp-up icon-btn" title="上へ">\u2191</button>
        <input class="fp-dir-input" type="text" style="flex:1;padding:4px 8px;background:var(--bg-input);border:1px solid var(--border);border-radius:4px;color:var(--fg-primary);font-size:13px" />
        <button class="fp-go" style="padding:4px 12px;background:var(--fg-accent);color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px">移動</button>
      </div>
      <div class="fp-entries" style="flex:1;overflow-y:auto;padding:4px 0;min-height:200px"></div>
      <div style="padding:8px 16px;border-top:1px solid var(--border);display:flex;gap:8px;align-items:center">
        <label style="font-size:13px;color:var(--fg-secondary);white-space:nowrap">ファイル名:</label>
        <input class="fp-filename" type="text" value="untitled.md" style="flex:1;padding:4px 8px;background:var(--bg-input);border:1px solid var(--border);border-radius:4px;color:var(--fg-primary);font-size:13px" />
      </div>
      <div style="padding:8px 16px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end">
        <button class="fp-cancel" style="padding:6px 16px;background:var(--bg-tertiary);color:var(--fg-primary);border:1px solid var(--border);border-radius:4px;cursor:pointer">キャンセル</button>
        <button class="fp-save" style="padding:6px 16px;background:var(--fg-accent);color:#fff;border:none;border-radius:4px;cursor:pointer">保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const dirInput = overlay.querySelector('.fp-dir-input');
  const filenameInput = overlay.querySelector('.fp-filename');
  const entriesDiv = overlay.querySelector('.fp-entries');
  let currentDir = '';

  // Set initial filename from defaultPath
  if (defaultPath) {
    const parts = defaultPath.replace(/\\/g, '/').split('/');
    filenameInput.value = parts.pop() || 'untitled.md';
  }

  async function navigate(dirPath) {
    try {
      const result = await backend.browseDir(dirPath);
      currentDir = result.current;
      dirInput.value = currentDir;
      renderEntries(result.entries);
    } catch (e) {
      console.error('Browse failed:', e);
    }
  }

  function renderEntries(entries) {
    entriesDiv.innerHTML = '';
    for (const entry of entries) {
      const el = document.createElement('div');
      el.style.cssText =
        'padding:4px 16px;cursor:pointer;display:flex;align-items:center;gap:8px;font-size:13px;color:var(--fg-primary)';
      el.innerHTML = `<span style="color:var(--fg-muted)">${entry.is_dir ? '\u{1f4c1}' : '\u{1f4c4}'}</span><span>${entry.name}</span>`;
      el.addEventListener('mouseenter', () => (el.style.background = 'var(--bg-hover)'));
      el.addEventListener('mouseleave', () => (el.style.background = ''));
      if (entry.is_dir) {
        el.addEventListener('dblclick', () => navigate(entry.path));
      } else {
        el.addEventListener('click', () => {
          filenameInput.value = entry.name;
        });
      }
      entriesDiv.appendChild(el);
    }
  }

  // Events
  overlay.querySelector('.fp-close').addEventListener('click', () => overlay.remove());
  overlay.querySelector('.fp-cancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  overlay.querySelector('.fp-up').addEventListener('click', async () => {
    const result = await backend.browseDir(currentDir);
    if (result.parent !== currentDir) navigate(result.parent);
  });

  overlay.querySelector('.fp-go').addEventListener('click', () => navigate(dirInput.value));
  dirInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') navigate(dirInput.value);
  });

  overlay.querySelector('.fp-save').addEventListener('click', () => {
    const filename = filenameInput.value.trim();
    if (filename && currentDir) {
      const sep = currentDir.includes('\\') ? '\\' : '/';
      const fullPath = currentDir + sep + filename;
      overlay.remove();
      onSelect(fullPath);
    }
  });

  filenameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') overlay.querySelector('.fp-save').click();
  });

  // Start navigation
  if (defaultPath) {
    const dir = defaultPath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
    navigate(dir || '');
  } else {
    navigate('');
  }
}
