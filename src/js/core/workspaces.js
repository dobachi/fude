// workspaces.js - named workspaces: each keeps its own session (folder, tabs,
// view mode, sidebar), and each chooses which of those it keeps.
//
// Pure: every function takes a store and returns a new one, so the rules are
// testable without the app. The app (app.js) does the I/O: it reads the store
// at startup, writes the active workspace's session as it changes, and on a
// switch closes what is open and restores the other workspace's session.
//
// Store shape (also what workspaces.json holds):
//   { active: "default",
//     workspaces: [{ name, keep: {folder, tabs, view_mode, sidebar}, session }] }

export const DEFAULT_WORKSPACE = 'default';

/** What a workspace can keep, in the order the settings list them. */
export const KEEP_ITEMS = [
  { key: 'folder', label: '開いているフォルダ' },
  { key: 'tabs', label: '開いているタブ' },
  { key: 'view_mode', label: '表示モード（分割 / エディタ / プレビュー）' },
  { key: 'sidebar', label: 'サイドバーの表示 / 非表示' },
];

const MAX_NAME = 64;

/** Everything kept: the default, and what an older workspace gets. */
export function defaultKeep() {
  return Object.fromEntries(KEEP_ITEMS.map(({ key }) => [key, true]));
}

/** Fill in a keep object: missing or non-boolean entries count as kept. */
export function normalizeKeep(keep) {
  const k = keep && typeof keep === 'object' ? keep : {};
  return Object.fromEntries(KEEP_ITEMS.map(({ key }) => [key, k[key] !== false]));
}

function cleanName(name) {
  return typeof name === 'string' ? name.trim() : '';
}

/**
 * Turn whatever was read (workspaces.json, possibly missing or damaged) into a
 * usable store. Without a store, the existing single session becomes the
 * "default" workspace, so upgrading loses nothing.
 *
 * @param {object|null} raw what load_workspaces returned
 * @param {object|null} legacySession what load_session returned
 */
export function normalizeStore(raw, legacySession = null) {
  const seen = new Set();
  const workspaces = [];
  const list = raw && Array.isArray(raw.workspaces) ? raw.workspaces : [];
  for (const w of list) {
    const name = cleanName(w && w.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    workspaces.push({
      name,
      keep: normalizeKeep(w.keep),
      session: w.session && typeof w.session === 'object' ? w.session : null,
    });
  }
  if (!workspaces.length) {
    workspaces.push({
      name: DEFAULT_WORKSPACE,
      keep: defaultKeep(),
      session: legacySession && typeof legacySession === 'object' ? legacySession : null,
    });
  }
  const wanted = cleanName(raw && raw.active);
  const active = workspaces.some((w) => w.name === wanted) ? wanted : workspaces[0].name;
  return { active, workspaces };
}

/** The workspace named `name`, or undefined. */
export function findWorkspace(store, name) {
  return store.workspaces.find((w) => w.name === name);
}

/** The active workspace (normalizeStore guarantees there is one). */
export function activeWorkspace(store) {
  return findWorkspace(store, store.active) || store.workspaces[0];
}

/**
 * Why `name` cannot be used for a workspace, or null when it can.
 * @param {string} name
 * @param {object} store
 * @param {{except?: string}} [opts] a name the check ignores (renaming to itself)
 */
export function nameError(name, store, { except } = {}) {
  const n = cleanName(name);
  if (!n) return 'ワークスペース名を入力してください';
  if (n.length > MAX_NAME) return `ワークスペース名は ${MAX_NAME} 文字までです`;
  if (n !== except && findWorkspace(store, n)) return `「${n}」は既にあります`;
  return null;
}

/**
 * The part of `session` a workspace keeps. What is not kept is replaced by the
 * value a fresh start would have, so restoring it changes nothing.
 * @param {object|null} session
 * @param {object} keep
 */
export function filterSession(session, keep) {
  if (!session || typeof session !== 'object') return null;
  const k = normalizeKeep(keep);
  const out = { ...session };
  if (!k.folder) out.vault_path = null;
  if (!k.tabs) {
    out.open_tabs = [];
    out.active_tab = 0;
  }
  if (!k.view_mode) {
    out.view_mode = 'split';
    if (Array.isArray(out.open_tabs)) {
      out.open_tabs = out.open_tabs.map((t) => ({ ...t, view_mode: 'split' }));
    }
  }
  if (!k.sidebar) out.sidebar_visible = true;
  return out;
}

function replace(store, name, fn) {
  return {
    ...store,
    workspaces: store.workspaces.map((w) => (w.name === name ? fn(w) : w)),
  };
}

/** Record `session` as what workspace `name` keeps (filtered by its keep). */
export function withSession(store, name, session) {
  if (!findWorkspace(store, name)) return store;
  return replace(store, name, (w) => ({ ...w, session: filterSession(session, w.keep) }));
}

/** Add an empty workspace. Throws when the name is unusable. */
export function addWorkspace(store, name, keep = defaultKeep()) {
  const err = nameError(name, store);
  if (err) throw new Error(err);
  return {
    ...store,
    workspaces: [
      ...store.workspaces,
      { name: cleanName(name), keep: normalizeKeep(keep), session: null },
    ],
  };
}

/** Rename a workspace (following it when it is the active one). */
export function renameWorkspace(store, from, to) {
  if (!findWorkspace(store, from)) return store;
  const err = nameError(to, store, { except: from });
  if (err) throw new Error(err);
  const name = cleanName(to);
  const next = replace(store, from, (w) => ({ ...w, name }));
  return store.active === from ? { ...next, active: name } : next;
}

/**
 * Remove a workspace. The last one cannot go; removing the active one makes
 * the first remaining workspace active (the caller then switches to it).
 */
export function removeWorkspace(store, name) {
  if (!findWorkspace(store, name)) return store;
  if (store.workspaces.length <= 1) throw new Error('最後のワークスペースは削除できません');
  const workspaces = store.workspaces.filter((w) => w.name !== name);
  const active = store.active === name ? workspaces[0].name : store.active;
  return { ...store, active, workspaces };
}

/** Change what a workspace keeps, dropping from its session what it no longer keeps. */
export function setKeep(store, name, keep) {
  if (!findWorkspace(store, name)) return store;
  const k = normalizeKeep(keep);
  return replace(store, name, (w) => ({ ...w, keep: k, session: filterSession(w.session, k) }));
}

/** Make `name` the active workspace. */
export function setActive(store, name) {
  if (!findWorkspace(store, name)) return store;
  return { ...store, active: name };
}

/**
 * Whether switching away is safe now. Unsaved edits would be lost when the
 * tabs close, so they stop the switch; the caller tells the user which.
 * @param {Array<{dirty?: boolean, path?: string|null, name?: string}>} tabs
 * @returns {{ok: boolean, dirty: string[]}} names of the unsaved tabs
 */
export function switchBlockers(tabs) {
  const dirty = (tabs || [])
    .filter((t) => t && t.dirty)
    .map((t) => (t.path ? String(t.path).split(/[\\/]/).pop() : t.name || 'Untitled'));
  return { ok: dirty.length === 0, dirty };
}
