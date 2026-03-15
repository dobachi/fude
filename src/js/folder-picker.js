// folder-picker.js - Folder browser dialog for browser/remote mode
import * as backend from './backend.js';

export function openFolderPicker(onSelect) {
  const overlay = document.createElement('div');
  overlay.className = 'settings-overlay';
  overlay.innerHTML = `
    <div class="settings-panel" style="width:500px;max-height:70vh;display:flex;flex-direction:column">
      <div class="settings-header">
        <h2>フォルダを開く</h2>
        <button class="fp-close icon-btn">\u00d7</button>
      </div>
      <div class="fp-path-bar" style="padding:8px 16px;border-bottom:1px solid var(--border);display:flex;gap:8px;align-items:center">
        <button class="fp-up icon-btn" title="上へ">\u2191</button>
        <input class="fp-path-input" type="text" style="flex:1;padding:4px 8px;background:var(--bg-input);border:1px solid var(--border);border-radius:4px;color:var(--fg-primary);font-size:13px" />
        <button class="fp-go" style="padding:4px 12px;background:var(--fg-accent);color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px">移動</button>
      </div>
      <div class="fp-entries" style="flex:1;overflow-y:auto;padding:4px 0;min-height:200px"></div>
      <div style="padding:12px 16px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end">
        <button class="fp-cancel" style="padding:6px 16px;background:var(--bg-tertiary);color:var(--fg-primary);border:1px solid var(--border);border-radius:4px;cursor:pointer">キャンセル</button>
        <button class="fp-select" style="padding:6px 16px;background:var(--fg-accent);color:#fff;border:none;border-radius:4px;cursor:pointer">このフォルダを開く</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const pathInput = overlay.querySelector('.fp-path-input');
  const entriesDiv = overlay.querySelector('.fp-entries');
  let currentPath = '';

  async function navigate(dirPath) {
    try {
      const result = await backend.browseDir(dirPath);
      currentPath = result.current;
      pathInput.value = currentPath;
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
      }
      entriesDiv.appendChild(el);
    }
  }

  // Event handlers
  overlay.querySelector('.fp-close').addEventListener('click', () => overlay.remove());
  overlay.querySelector('.fp-cancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  overlay.querySelector('.fp-up').addEventListener('click', async () => {
    const result = await backend.browseDir(currentPath);
    if (result.parent !== currentPath) {
      navigate(result.parent);
    }
  });

  overlay.querySelector('.fp-go').addEventListener('click', () => {
    navigate(pathInput.value);
  });

  pathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') navigate(pathInput.value);
  });

  overlay.querySelector('.fp-select').addEventListener('click', () => {
    if (currentPath) {
      overlay.remove();
      onSelect(currentPath);
    }
  });

  // Start from home directory
  navigate('');
}
