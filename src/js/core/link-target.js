// link-target.js - Resolve a markdown link href into a local file target.
//
// Preview links come in four flavours:
//   http/https/mailto → handled by external-link.js (OS browser)
//   #anchor           → in-page scroll, handled by preview.js
//   relative/absolute path → THIS module: resolve to an absolute file path so
//                            the app can open it in a tab (GitHub-like browsing)
//   anything else (data:, javascript:, asset: …) → rejected
//
// Everything here is pure string work so it can be unit-tested without a
// webview or a filesystem.

// Schemes we refuse to treat as a local file. `file:` is handled separately
// (stripped to a plain path) because it *does* name a local file.
const REJECTED_SCHEME = /^(https?|mailto|data|javascript|asset|blob|tauri|vscode):/i;

/** True when the path is rooted: POSIX "/", UNC "\\", or a Windows drive. */
function isAbsolutePath(p) {
  return /^(\/|\\|[A-Za-z]:[/\\])/.test(p);
}

/**
 * Collapse "." and ".." segments. Keeps the root prefix ("/" or "C:/") intact
 * and refuses to climb above it. Relative inputs may keep leading ".." parts
 * (the caller has already joined a base path, so this should not happen, but
 * dropping them silently would be worse than keeping them).
 */
export function normalizePath(path) {
  const unix = String(path).replace(/\\/g, '/');
  const driveMatch = unix.match(/^[A-Za-z]:\//);
  const root = driveMatch ? driveMatch[0] : unix.startsWith('/') ? '/' : '';
  const body = unix.slice(root.length);
  const out = [];
  for (const seg of body.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!root) out.push('..'); // relative path: keep, nothing to pop
      // rooted path: ".." at the root is a no-op, matching OS behaviour
      continue;
    }
    out.push(seg);
  }
  return root + out.join('/');
}

/**
 * Resolve a markdown href against the document's directory.
 *
 * @param {string} href - raw href attribute from the rendered markdown
 * @param {string} basePath - directory of the document containing the link
 * @returns {{path: string, hash: string} | null} absolute file path plus the
 *   fragment (without "#", may be ""), or null when the href is not a local
 *   file link we can resolve.
 */
export function resolveLinkTarget(href, basePath = '') {
  if (typeof href !== 'string') return null;
  let raw = href.trim();
  if (!raw) return null;
  if (raw.startsWith('#')) return null; // in-page anchor, not a file
  if (REJECTED_SCHEME.test(raw)) return null;

  // file:///abs/path → /abs/path (and file://C:/… on Windows)
  if (/^file:\/\//i.test(raw)) raw = raw.replace(/^file:\/\//i, '') || '/';

  // Split the fragment off before decoding so a literal "%23" in a filename
  // survives as part of the name rather than becoming a separator.
  const hashIndex = raw.indexOf('#');
  const hash = hashIndex >= 0 ? raw.slice(hashIndex + 1) : '';
  let pathPart = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
  if (!pathPart) return null; // was just a fragment after all

  // Markdown links to files with spaces arrive percent-encoded.
  pathPart = safeDecode(pathPart);

  const absolute = isAbsolutePath(pathPart);
  if (!absolute && !basePath) return null; // nothing to resolve against
  const joined = absolute ? pathPart : `${String(basePath).replace(/[/\\]+$/, '')}/${pathPart}`;
  const path = normalizePath(joined);
  if (!path) return null;
  return { path, hash: safeDecode(hash) };
}

/** decodeURIComponent that returns the input unchanged on malformed escapes. */
function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
