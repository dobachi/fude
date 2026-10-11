// setup-hosts.js - the ssh hosts registered from the settings panel
// (`fude-cli setup HOST`). Pure list/validation logic; the panel itself is
// features/remote/setup-panel.js.

/**
 * Why `host` cannot be handed to `fude-cli setup`, or null when it can.
 * Mirrors `valid_ssh_host` in src-tauri/src/lib.rs, which has the last word.
 */
export function hostError(host) {
  const h = String(host ?? '').trim();
  if (!h) return 'ホスト名を入力してください';
  if (h.length > 255 || h.startsWith('-') || !/^[A-Za-z0-9._@:-]+$/.test(h)) {
    return `ホスト名として使えません: ${h}`;
  }
  return null;
}

/** The notice shown when `host`'s fude-cli is older than this Fude. */
export function outdatedCliMessage(host, cli, gui) {
  return `${host} の fude-cli（${cli}）はこの Fude（${gui}）より古い版です。設定の「リモート接続」で「更新」できます`;
}

function clean(list) {
  return (Array.isArray(list) ? list : []).filter((h) => typeof h === 'string' && h.trim());
}

/** `list` with `host` added at the end, unless it is already there. */
export function addHost(list, host) {
  const hosts = clean(list);
  const h = String(host ?? '').trim();
  if (!h || hosts.includes(h)) return hosts;
  return [...hosts, h];
}

/** `list` without `host`. */
export function removeHost(list, host) {
  const h = String(host ?? '').trim();
  return clean(list).filter((x) => x !== h);
}
