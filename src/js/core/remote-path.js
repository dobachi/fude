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
