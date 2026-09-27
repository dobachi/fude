// startup-plan.js - decide what to open at startup: the saved session, the
// folder fude-browser was launched with (--open-dir), or its --root.
//
// Browser mode confines every path to --root. A session saved elsewhere (the
// desktop app shares the session file) can point outside it, and restoring it
// used to fail silently: every read was refused, the errors were swallowed, and
// the user got an empty sidebar and no tabs — with --open-dir never consulted,
// because it was only read when there was no session at all.
//
// This is the pure half: given the session and the launch options, what to
// open and what to leave out. The caller does the I/O and reports what it left
// out or failed to load.

/** Normalise for comparison: forward slashes, no trailing slash (except "/"). */
function norm(p) {
  const s = String(p).replace(/\\/g, '/');
  return s.length > 1 ? s.replace(/\/+$/, '') : s;
}

/**
 * True when `p` is `root` or inside it. No root means no confinement.
 * Mirrors the server's own check closely enough for planning; the server
 * remains the authority and still refuses anything outside.
 * @param {string} p
 * @param {string|null|undefined} root
 */
export function isInsideRoot(p, root) {
  if (!root) return true;
  if (!p) return false;
  const r = norm(root);
  const x = norm(p);
  if (x === r) return true;
  return x.startsWith(r === '/' ? '/' : `${r}/`);
}

/**
 * @param {object} args
 * @param {{vault_path?: string|null, open_tabs?: Array<{path?: string|null}>}|null} args.session
 * @param {{open_dir?: string|null, root?: string|null}|null} args.startup
 *   browser-mode launch options (null on the desktop)
 * @returns {{
 *   vault: string|null,
 *   tabs: Array<object>,
 *   restoreSession: boolean,
 *   skipped: string[],
 * }}
 *   vault: folder for the sidebar (null = none); tabs: session tabs to reopen;
 *   restoreSession: whether any session state is being restored; skipped:
 *   session paths left out because they are outside --root.
 */
export function planStartup({ session, startup }) {
  const openDir = (startup && startup.open_dir) || null;
  const root = (startup && startup.root) || null;
  const skipped = [];

  const savedTabs = (session && Array.isArray(session.open_tabs) && session.open_tabs) || [];
  const tabs = [];
  for (const tab of savedTabs) {
    if (!tab || !tab.path) continue;
    if (isInsideRoot(tab.path, root)) tabs.push(tab);
    else skipped.push(tab.path);
  }

  const savedVault = (session && session.vault_path) || null;
  const savedVaultOk = savedVault && isInsideRoot(savedVault, root);

  // An explicit --open-dir is what the user asked for on this launch, so it
  // wins over whatever folder the session last had open. Without it, the
  // session's folder if usable, else --root.
  // A session with no reopenable tabs is not restored at all (as before), so
  // its folder is not either; only the launch options apply then.
  const restoreSession = tabs.length > 0;
  if (restoreSession && savedVault && !savedVaultOk) skipped.push(savedVault);
  const vault = restoreSession
    ? openDir || (savedVaultOk ? savedVault : null) || root || null
    : openDir || root || null;

  return { vault, tabs, restoreSession, skipped };
}

/** Last path segment, for short lists in a notice. */
function baseName(p) {
  const parts = norm(p).split('/');
  return parts[parts.length - 1] || p;
}

/**
 * The message to show when startup could not restore everything, or null.
 * @param {{skipped?: string[], failed?: string[]}} problems
 *   skipped: left out because they are outside --root; failed: tried and
 *   refused or unreadable
 * @returns {string|null}
 */
export function startupNotice({ skipped = [], failed = [] } = {}) {
  const list = (paths) => {
    const names = paths.slice(0, 3).map(baseName).join(', ');
    return paths.length > 3 ? `${names} ほか` : names;
  };
  const parts = [];
  if (skipped.length) {
    parts.push(
      `前回のセッションの ${skipped.length} 件は --root の外にあるため開きませんでした（${list(skipped)}）`,
    );
  }
  if (failed.length) {
    parts.push(`前回のセッションの ${failed.length} 件を読み込めませんでした（${list(failed)}）`);
  }
  return parts.length ? parts.join('。') : null;
}
