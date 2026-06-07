// dialog.js - Minimal modal prompt/confirm dialogs (Promise-based).
// The Tauri webview doesn't reliably support window.prompt/confirm, so we
// provide small in-app modals styled like the rest of the UI.

function buildOverlay(inner) {
  const overlay = document.createElement('div');
  overlay.className = 'settings-overlay';
  overlay.innerHTML = `<div class="settings-panel" style="width:380px">${inner}</div>`;
  document.body.appendChild(overlay);
  return overlay;
}

/**
 * Text input dialog. Resolves with the trimmed string, or null if cancelled.
 * @param {string} message
 * @param {string} [defaultValue]
 * @param {string} [okLabel]
 */
export function promptDialog(message, defaultValue = '', okLabel = 'OK') {
  return new Promise((resolve) => {
    const overlay = buildOverlay(`
      <div class="settings-body" style="padding:16px">
        <p style="margin:0 0 8px;color:var(--fg-primary);font-size:13px">${message}</p>
        <input class="dlg-input" type="text" style="width:100%;padding:6px 8px;background:var(--bg-input);border:1px solid var(--border);border-radius:4px;color:var(--fg-primary);font-size:13px" />
      </div>
      <div class="settings-footer" style="display:flex;gap:8px;justify-content:flex-end">
        <button class="dlg-cancel" style="padding:6px 14px;background:var(--bg-tertiary);color:var(--fg-primary);border:1px solid var(--border);border-radius:4px;cursor:pointer">キャンセル</button>
        <button class="dlg-ok" style="padding:6px 14px;background:var(--fg-accent);color:#fff;border:none;border-radius:4px;cursor:pointer">${okLabel}</button>
      </div>`);
    const input = overlay.querySelector('.dlg-input');
    input.value = defaultValue;
    const done = (val) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const submit = () => {
      const v = input.value.trim();
      done(v ? v : null);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') done(null);
      else if (e.key === 'Enter') submit();
    };
    overlay.querySelector('.dlg-ok').addEventListener('click', submit);
    overlay.querySelector('.dlg-cancel').addEventListener('click', () => done(null));
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) done(null);
    });
    document.addEventListener('keydown', onKey);
    input.focus();
    input.select();
  });
}

/**
 * Confirm dialog. Resolves true/false.
 * @param {string} message
 * @param {{ okLabel?: string, danger?: boolean }} [opts]
 */
export function confirmDialog(message, opts = {}) {
  const { okLabel = 'OK', danger = false } = opts;
  return new Promise((resolve) => {
    const overlay = buildOverlay(`
      <div class="settings-body" style="padding:16px">
        <p style="margin:0;color:var(--fg-primary);font-size:13px;white-space:pre-wrap">${message}</p>
      </div>
      <div class="settings-footer" style="display:flex;gap:8px;justify-content:flex-end">
        <button class="dlg-cancel" style="padding:6px 14px;background:var(--bg-tertiary);color:var(--fg-primary);border:1px solid var(--border);border-radius:4px;cursor:pointer">キャンセル</button>
        <button class="dlg-ok" style="padding:6px 14px;background:${danger ? '#a4262c' : 'var(--fg-accent)'};color:#fff;border:none;border-radius:4px;cursor:pointer">${okLabel}</button>
      </div>`);
    const done = (val) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') done(false);
      else if (e.key === 'Enter') done(true);
    };
    overlay.querySelector('.dlg-ok').addEventListener('click', () => done(true));
    overlay.querySelector('.dlg-cancel').addEventListener('click', () => done(false));
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) done(false);
    });
    document.addEventListener('keydown', onKey);
  });
}
