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
