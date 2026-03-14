// updater.js - Auto-update check on startup

export async function checkForUpdates() {
  if (!window.__TAURI__) return;

  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (update) {
      showUpdateDialog(update);
    }
  } catch (e) {
    console.info('Update check skipped:', e.message || e);
  }
}

function showUpdateDialog(update) {
  const overlay = document.createElement('div');
  overlay.className = 'settings-overlay';
  overlay.innerHTML = `
    <div class="settings-panel" style="width:400px">
      <div class="settings-body" style="padding:20px">
        <p style="margin-bottom:8px;color:var(--fg-primary);font-weight:600">Fude ${update.version} が利用可能です</p>
        <p style="margin-bottom:16px;color:var(--fg-secondary);font-size:13px">${update.body || ''}</p>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button class="btn-skip" style="padding:6px 16px;background:var(--bg-tertiary);color:var(--fg-primary);border:1px solid var(--border);border-radius:4px;cursor:pointer">スキップ</button>
          <button class="btn-update" style="padding:6px 16px;background:var(--fg-accent);color:#fff;border:none;border-radius:4px;cursor:pointer">アップデート</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector('.btn-skip').addEventListener('click', () => overlay.remove());
  overlay.querySelector('.btn-update').addEventListener('click', async () => {
    overlay.querySelector('.btn-update').textContent = 'ダウンロード中...';
    overlay.querySelector('.btn-update').disabled = true;
    overlay.querySelector('.btn-skip').disabled = true;
    try {
      await update.downloadAndInstall();
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch (e) {
      console.error('Update failed:', e);
      overlay.remove();
    }
  });
}
