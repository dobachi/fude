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

/**
 * Canonical form used only for *comparing* paths — never for file I/O.
 *
 * `\\wsl$\<distro>\…` and `\\wsl.localhost\<distro>\…` name the same location
 * (the former is the older alias), but they are different strings. Tana hands
 * Fude the `wsl.localhost` form while Explorer and older sessions use `wsl$`,
 * so the same file was treated as two different files: it opened in a second
 * tab, the status bar refused to show it as vault-relative, and revealing it in
 * the tree missed. Paths are still opened exactly as they were handed to us.
 *
 * @param {string} path
 * @returns {string}
 */
export function canonicalPath(path) {
  return String(path ?? '').replace(/^\\\\wsl\$\\/i, '\\\\wsl.localhost\\');
}

/**
 * Whether two paths name the same file, ignoring the WSL UNC alias. Case is
 * still significant (Fude's target platforms are Linux/WSL).
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function samePath(a, b) {
  const ca = canonicalPath(a);
  return !!ca && ca === canonicalPath(b);
}

/**
 * Directory that the file-tree pane should show for a given file path.
 * Handles both POSIX (/) and Windows (\) separators, and keeps the separator
 * for root-level files (`/foo.md` -> `/`, `C:\foo.md` -> `C:\`).
 * Returns '' when there is no usable parent (empty path, or a bare filename).
 *
 * @param {string} filePath
 * @returns {string}
 */
export function fileDirForTree(filePath) {
  const p = String(filePath ?? '').trim();
  if (!p) return '';
  const lastSep = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  if (lastSep < 0) return '';
  if (lastSep === 0) return p[0]; // '/foo.md' -> '/'
  if (lastSep === 2 && /^[A-Za-z]:$/.test(p.slice(0, 2))) return p.slice(0, 3); // 'C:\foo.md'
  return p.slice(0, lastSep);
}

/** Trailing separators are cosmetic: drop them, but never eat a bare root. */
function trimTrailingSep(path) {
  const s = String(path ?? '');
  if (s.length <= 1) return s;
  return s.replace(/[/\\]+$/, '') || s[0];
}

/**
 * Whether `child` is `parent` itself or lives somewhere below it. Trailing
 * separators are ignored; empty paths are never inside anything. Comparison is
 * case-sensitive (Fude's target platforms are Linux/WSL).
 *
 * @param {string} child
 * @param {string} parent
 * @returns {boolean}
 */
export function isWithinDir(child, parent) {
  const c = trimTrailingSep(canonicalPath(child));
  const p = trimTrailingSep(canonicalPath(parent));
  if (!c || !p) return false;
  if (c === p) return true;
  // A root ('/') already carries its separator; 'C:' needs one appended.
  const prefix = /[/\\]$/.test(p) ? p : p + (c.includes('\\') || p.includes('\\') ? '\\' : '/');
  return c.startsWith(prefix);
}

/**
 * Decide what "show the active file's folder in the file tree" should do.
 *
 * A file that already lives under the loaded tree root is only revealed in
 * place — re-rooting there would needlessly narrow the visible tree. Only a
 * file outside the current root moves the root to its own folder.
 *
 * @param {string} filePath path of the file to reveal (may be null/empty)
 * @param {string} vaultPath folder currently loaded as the tree root
 * @returns {{action: 'none'|'reveal'|'open', dir: string}}
 *   'none'   — no saved file to locate (unsaved tab / nothing open)
 *   'reveal' — already inside the tree root; expand and highlight only
 *   'open'   — load `dir` as the new tree root
 */
export function resolveRevealDir(filePath, vaultPath) {
  const dir = fileDirForTree(filePath);
  if (!dir) return { action: 'none', dir: '' };
  if (isWithinDir(dir, vaultPath)) return { action: 'reveal', dir };
  return { action: 'open', dir };
}
