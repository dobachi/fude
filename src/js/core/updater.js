// updater.js - Auto-update check (startup + manual "Check for updates")
import { isLocalTauri } from '../backend.js';

/**
 * Decide the user-facing feedback for a manual update check. Pure so it can be
 * unit tested without the Tauri runtime.
 *
 * @param {object} state
 * @param {boolean} state.isDesktop  running inside the Tauri (desktop) app
 * @param {object|null} state.update  result of updater check() (null = up to date)
 * @param {string|null} state.error  error message if the check threw
 * @returns {{kind: 'unsupported'|'error'|'update'|'latest', message?: string, type?: string, version?: string}}
 */
export function describeManualCheck({ isDesktop, update, error }) {
  if (!isDesktop) {
    return {
      kind: 'unsupported',
      type: 'error',
      message: 'アップデートの確認はデスクトップ版でのみ利用できます。',
    };
  }
  if (error) {
    return { kind: 'error', type: 'error', message: `アップデートの確認に失敗しました: ${error}` };
  }
  if (update) {
    return { kind: 'update', version: update.version };
  }
  return { kind: 'latest', type: 'info', message: '最新版を使用しています。' };
}

/**
 * Check for updates. On startup (manual=false) this is silent: it only surfaces
 * a dialog when an update exists. When invoked manually it also reports "up to
 * date", errors, and the unsupported (browser) case via the notify callback.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.manual=false]  manual invocation (show all outcomes)
 * @param {(message: string, type: string) => void} [opts.notify]  toast sink
 */
export async function checkForUpdates(opts = {}) {
  const manual = !!opts.manual;
  const notify = opts.notify;

  if (!isLocalTauri()) {
    if (manual) {
      const r = describeManualCheck({ isDesktop: false, update: null, error: null });
      notify?.(r.message, r.type);
    }
    return;
  }

  let update = null;
  let error = null;
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    update = await check();
  } catch (e) {
    error = e?.message || String(e);
  }

  if (update) {
    showUpdateDialog(update);
    return;
  }

  if (!manual) {
    if (error) console.info('Update check skipped:', error);
    return;
  }

  const r = describeManualCheck({ isDesktop: true, update: null, error });
  notify?.(r.message, r.type);
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
