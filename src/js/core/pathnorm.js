// pathnorm.js - Pure helpers to normalize a user-typed path before opening.
// Kept dependency-free (no DOM / no Tauri) so it can be unit-tested directly.
//
// Fude on WSL runs the Linux build under WSLg, so paths are always POSIX
// (`/home/...`, `/mnt/c/...`). Tilde therefore always means the Linux home.

/**
 * Strip decorations commonly present when a path is pasted from a terminal:
 * surrounding quotes (`'…'` / `"…"`), leading/trailing whitespace, and
 * backslash-escaped spaces (`foo\ bar` -> `foo bar`). The middle of the path
 * is otherwise left untouched.
 *
 * @param {string} raw
 * @returns {string}
 */
export function stripPathDecorations(raw) {
  let s = String(raw ?? '').trim();
  if (s.length >= 2) {
    const a = s[0];
    const b = s[s.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) {
      s = s.slice(1, -1);
    }
  }
  // Un-escape shell-escaped spaces. Do this after unquoting so a quoted path
  // that legitimately contains "\ " is preserved by the caller's intent.
  s = s.replace(/\\ /g, ' ');
  return s.trim();
}

/**
 * Expand a leading `~` / `~/…` to `home`. `~user` forms are not expanded
 * (left as-is) since they're rare and need a user lookup.
 *
 * @param {string} path
 * @param {string} home absolute home path, no trailing slash
 * @returns {string}
 */
export function expandTilde(path, home) {
  if (!home) return path;
  if (path === '~') return home;
  if (path.startsWith('~/')) return home + '/' + path.slice(2);
  return path;
}

/**
 * Full normalization: strip decorations, then expand `~`.
 * Returns '' for empty / whitespace-only input.
 *
 * @param {string} raw
 * @param {string} [home]
 * @returns {string}
 */
export function normalizeInputPath(raw, home = '') {
  const s = stripPathDecorations(raw);
  if (!s) return '';
  return expandTilde(s, home);
}
