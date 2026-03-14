// updater.js - Auto-update check on startup

export async function checkForUpdates() {
  if (!window.__TAURI__) return;

  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (update) {
      const shouldUpdate = confirm(
        `Fude ${update.version} が利用可能です。\n\n${update.body || ''}\n\nアップデートしますか？`,
      );
      if (shouldUpdate) {
        await update.downloadAndInstall();
        const { relaunch } = await import('@tauri-apps/plugin-process');
        await relaunch();
      }
    }
  } catch (e) {
    console.info('Update check skipped:', e.message || e);
  }
}
