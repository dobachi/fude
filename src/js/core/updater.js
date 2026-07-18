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
/**
 * Build the message shown when installing an update fails.
 *
 * Kept pure (no DOM, no Tauri) so the wording and the platform-specific hint
 * are testable. The Linux hint matters: deb/rpm updates shell out to
 * `pkexec dpkg`, which cannot authenticate under WSL (polkit has no session),
 * so the in-app update can never succeed there — telling the user to retry
 * forever would be wrong.
 * @param {unknown} error
 * @param {{isLinux?: boolean}} [opts]
 * @returns {{detail: string, hint: string}}
 */
export function describeInstallError(error, opts = {}) {
  const { isLinux = false } = opts;
  const detail = error && error.message ? error.message : String(error ?? '不明なエラー');
  const hint = isLinux
    ? 'Linux の deb / rpm 版は、インストールに管理者権限（PolicyKit）が必要です。WSL など認証できない環境ではアプリ内での更新を完了できません。お手数ですが、リリースページから手動で更新してください。'
    : '時間をおいて再試行するか、リリースページから手動で更新してください。';
  return { detail, hint };
}

/** Whether the current platform is Linux (used to pick the failure hint). */
export function isLinuxPlatform(nav = typeof navigator !== 'undefined' ? navigator : null) {
  const s = `${nav?.platform || ''} ${nav?.userAgent || ''}`;
  return /linux/i.test(s) && !/android/i.test(s);
}

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
      showInstallError(overlay, e);
    }
  });
}

/**
 * Replace the dialog body with the failure reason. Previously the dialog just
 * disappeared on error, leaving the user with no idea why nothing happened
 * (on WSL the PolicyKit prompt fails and this was the only feedback).
 */
function showInstallError(overlay, error) {
  const { detail, hint } = describeInstallError(error, { isLinux: isLinuxPlatform() });
  const body = overlay.querySelector('.settings-body');
  if (!body) {
    overlay.remove();
    return;
  }
  body.innerHTML = `
    <p style="margin-bottom:8px;color:var(--fg-primary);font-weight:600">アップデートに失敗しました</p>
    <p class="update-error-detail" style="margin-bottom:12px;color:var(--fg-secondary);font-size:13px;word-break:break-word">${escapeText(detail)}</p>
    <p class="update-error-hint" style="margin-bottom:16px;color:var(--fg-secondary);font-size:13px">${escapeText(hint)}</p>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button class="btn-close" style="padding:6px 16px;background:var(--bg-tertiary);color:var(--fg-primary);border:1px solid var(--border);border-radius:4px;cursor:pointer">閉じる</button>
    </div>`;
  body.querySelector('.btn-close').addEventListener('click', () => overlay.remove());
  body.querySelector('.btn-close').focus();
}

/** Escape text destined for innerHTML (error messages can contain markup). */
function escapeText(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}
