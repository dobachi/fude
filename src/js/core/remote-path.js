// remote-path.js - Paths of files served by a remote `fude-cli` agent.
//
// Such a tab's path is `remote://<host><absolute path on host>`; the host
// routes reads, writes and watches to the agent (see fude_core::ipc, which
// this mirrors). Everything else in the app treats it as an opaque path.

export const REMOTE_SCHEME = 'remote://';

/** @param {string|null|undefined} path */
export function isRemotePath(path) {
  return typeof path === 'string' && path.startsWith(REMOTE_SCHEME);
}

/**
 * Split `remote://host/abs/path` into its parts, or null for anything else.
 * @param {string} path
 * @returns {{ host: string, path: string } | null}
 */
export function splitRemotePath(path) {
  if (!isRemotePath(path)) return null;
  const rest = path.slice(REMOTE_SCHEME.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  return { host: rest.slice(0, slash), path: rest.slice(slash) };
}

/** The host part, or null. */
export function remoteHost(path) {
  const parts = splitRemotePath(path);
  return parts ? parts.host : null;
}

/**
 * How to show a remote path to the user: `host:/abs/path`.
 * @param {string} path
 */
export function displayRemotePath(path) {
  const parts = splitRemotePath(path);
  return parts ? `${parts.host}:${parts.path}` : path;
}

/**
 * The remote path a document in `baseDir` (`remote://host/dir`) means by
 * `file`: relative to the document's directory, or from the host's root when
 * it starts with `/`. `.` and `..` are resolved here, because the agent
 * refuses any path that still contains `..`; going above the root stops at it.
 * Null when `baseDir` is not a remote path.
 * @param {string} baseDir
 * @param {string} file
 * @returns {string|null}
 */
export function resolveRemotePath(baseDir, file) {
  // A trailing slash keeps `remote://host` itself splittable.
  const parts = splitRemotePath(isRemotePath(baseDir) ? `${baseDir}/` : baseDir);
  if (!parts) return null;
  const rel = String(file ?? '').replace(/\\/g, '/');
  const from = rel.startsWith('/') ? rel : `${parts.path}/${rel}`;
  const out = [];
  for (const seg of from.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return `${REMOTE_SCHEME}${parts.host}/${out.join('/')}`;
}

/**
 * Where "Save As" on a remote tab writes, from what was typed: a name or a
 * relative path (from `baseDir`, the tab's folder), `/abs/path` on the same
 * host, or the path written out as shown (`host:/abs/path`) or in full
 * (`remote://host/abs/path`). Null for another host, an empty input or one
 * naming a folder (ending in `/`): the native dialog cannot reach a host, so
 * the file stays where its connection is.
 * @param {string} baseDir
 * @param {string} input
 * @returns {string|null}
 */
export function remoteSaveAsPath(baseDir, input) {
  const typed = String(input ?? '').trim();
  if (!typed || /[/\\]$/.test(typed)) return null;
  return resolveTypedPath(baseDir, typed);
}

/** `typed` (a name, a path, `host:/path` or `remote://host/path`) as a
 *  remote path on `baseDir`'s host, or null for another host. */
function resolveTypedPath(baseDir, typed) {
  const host = remoteHost(isRemotePath(baseDir) ? `${baseDir}/` : baseDir);
  if (!host) return null;
  let rel = typed;
  const full = splitRemotePath(rel);
  const shown = /^([^/\\:]+):(\/.*)$/.exec(rel);
  if (full || shown) {
    if ((full ? full.host : shown[1]) !== host) return null;
    rel = full ? full.path : shown[2];
  }
  return resolveRemotePath(baseDir, rel);
}

/**
 * What to list for completing `typed` in the remote "Save As" field: the
 * folder up to its last `/` (`dir`, a remote path), that part as typed
 * (`shownDir`, kept so candidates read like the input) and the rest
 * (`prefix`, what names must start with). Null for another host.
 * @param {string} baseDir
 * @param {string} typed
 * @returns {{ dir: string, shownDir: string, prefix: string } | null}
 */
export function saveAsCompletionQuery(baseDir, typed) {
  const t = String(typed ?? '');
  const cut = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'));
  const shownDir = t.slice(0, cut + 1);
  const dir = resolveTypedPath(baseDir, shownDir || '.');
  if (!dir) return null;
  return { dir, shownDir, prefix: t.slice(cut + 1) };
}

/**
 * The candidates for a `saveAsCompletionQuery` result, from the folder's
 * `entries` (`{ name, is_dir }`): the input with a matching name written
 * out, folders ending in `/` to go on into. Hidden names only once a `.`
 * is typed; the input itself is not offered.
 * @param {{ shownDir: string, prefix: string } | null} query
 * @param {{ name: string, is_dir: boolean }[]} entries
 * @returns {string[]}
 */
export function saveAsCompletions(query, entries) {
  if (!query || !Array.isArray(entries)) return [];
  const { shownDir, prefix } = query;
  const out = [];
  for (const e of entries) {
    const name = e?.name;
    if (typeof name !== 'string' || !name.startsWith(prefix)) continue;
    if (name.startsWith('.') && !prefix.startsWith('.')) continue;
    if (!e.is_dir && name === prefix) continue;
    out.push(`${shownDir}${name}${e.is_dir ? '/' : ''}`);
  }
  return out.slice(0, SAVE_AS_SUGGEST_MAX);
}

/** How many candidates the remote "Save As" field shows. */
const SAVE_AS_SUGGEST_MAX = 50;

const IMAGE_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
};

/**
 * The media type to give an image's bytes, by file extension. An <img>
 * sniffs most bitmap formats on its own, but an SVG shows only when it is
 * labelled as one. Unknown extensions get the generic type.
 * @param {string} path
 */
export function imageMime(path) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(path ?? ''));
  return (m && IMAGE_MIME[m[1].toLowerCase()]) || 'application/octet-stream';
}

/**
 * The folder above a remote folder, as a remote path; null at the host's
 * root and for anything that is not a remote path.
 * @param {string} path
 * @returns {string|null}
 */
export function remoteParent(path) {
  const parts = splitRemotePath(path);
  if (!parts) return null;
  const p = parts.path.replace(/\/+$/, '');
  if (!p) return null; // already the root
  const cut = p.lastIndexOf('/');
  return `${REMOTE_SCHEME}${parts.host}${cut <= 0 ? '/' : p.slice(0, cut)}`;
}

/**
 * The connection that serves `path`: on the same host, with the longest root
 * `path` lies in. Null when none does (the agent went away).
 * @param {string} path a remote path
 * @param {{id:number,host:string,roots:string[],origin:?string}[]} connections
 */
export function connectionFor(path, connections) {
  const parts = splitRemotePath(path);
  if (!parts) return null;
  let best = null;
  let bestLen = -1;
  for (const c of Array.isArray(connections) ? connections : []) {
    if (!c || c.host !== parts.host) continue;
    for (const root of Array.isArray(c.roots) ? c.roots : []) {
      const r = String(root).replace(/\/+$/, '') || '/';
      const inside = r === '/' || parts.path === r || parts.path.startsWith(`${r}/`);
      if (inside && r.length > bestLen) {
        best = c;
        bestLen = r.length;
      }
    }
  }
  return best;
}

/**
 * How to reach the machine a remote folder is on again, for opening another
 * place there: `{ kind: 'wsl' }`, or `{ kind: 'ssh', host }` — the ssh
 * destination this window used when it opened the connection itself, else
 * the name the agent goes by (which ssh may or may not know: `known` tells).
 * Null for anything that is not a remote path.
 */
export function remoteReach(path, connections) {
  const parts = splitRemotePath(path);
  if (!parts) return null;
  const origin = connectionFor(path, connections)?.origin || '';
  if (origin === 'wsl') return { kind: 'wsl', known: true };
  if (origin.startsWith('ssh:') && origin.length > 4) {
    return { kind: 'ssh', host: origin.slice(4), known: true };
  }
  return { kind: 'ssh', host: parts.host, known: false };
}
