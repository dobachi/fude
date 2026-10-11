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
  return `${host} の fude-cli（${cli}）はこの Fude（${gui}）より古い版です。メニュー「ファイル」→「リモート接続」で「更新」できます`;
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

/** The pseudo-host under which places opened inside WSL are remembered. */
export const WSL_HOST = 'wsl';

/** How many remembered places are kept, over all hosts. */
export const RECENT_MAX = 40;

const SEP = '\t';

/**
 * `list` (entries `host<TAB>path`, newest first) with this place put first.
 * An empty path is the home directory, remembered as `~`.
 */
export function addRecent(list, host, path) {
  const h = String(host ?? '').trim();
  if (!h) return clean(list);
  const p = String(path ?? '').trim() || '~';
  const entry = `${h}${SEP}${p}`;
  return [entry, ...clean(list).filter((e) => e !== entry)].slice(0, RECENT_MAX);
}

/** The paths remembered for `host`, newest first. */
export function recentPaths(list, host) {
  const prefix = `${String(host ?? '').trim()}${SEP}`;
  return clean(list)
    .filter((e) => e.startsWith(prefix))
    .map((e) => e.slice(prefix.length));
}

/** `list` without anything remembered for `host`. */
export function forgetRecent(list, host) {
  const prefix = `${String(host ?? '').trim()}${SEP}`;
  return clean(list).filter((e) => !e.startsWith(prefix));
}

/** The ssh hosts places were opened on, newest first (WSL is not one). */
export function recentHosts(list) {
  const hosts = [];
  for (const e of clean(list)) {
    const i = e.indexOf(SEP);
    const h = i > 0 ? e.slice(0, i) : '';
    if (h && h !== WSL_HOST && !hosts.includes(h)) hosts.push(h);
  }
  return hosts;
}

/**
 * The hosts offered as destinations: the ones used lately first, then the
 * ones set up, then the names in the ssh config. Each once.
 */
export function openTargets(recent, setupHosts, candidates) {
  const out = [];
  for (const h of [...recentHosts(recent), ...clean(setupHosts), ...clean(candidates)]) {
    const name = h.trim();
    if (name && !hostError(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

/** The longest string every one of `strings` starts with. */
export function commonPrefix(strings) {
  const list = clean(strings);
  if (!list.length) return '';
  let prefix = list[0];
  for (const s of list.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < s.length && prefix[i] === s[i]) i++;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  return prefix;
}

/** How many suggestions are shown under the path field. */
export const SUGGEST_MAX = 50;

/**
 * What to offer under the path field for `typed`: the places opened there
 * before that match (all of them while nothing is typed), then what the far
 * side says the path could be completed to. Each once, what was typed
 * itself left out.
 */
export function pathSuggestions(typed, recent, completions) {
  const t = String(typed ?? '');
  const out = [];
  const add = (p) => {
    if (typeof p === 'string' && p && p !== t && !out.includes(p)) out.push(p);
  };
  for (const p of clean(recent)) if (!t || p.startsWith(t)) add(p);
  for (const p of clean(completions)) add(p);
  return out.slice(0, SUGGEST_MAX);
}
