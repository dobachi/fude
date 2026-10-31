// remote-spec.js - Read a remote place written on one line (the same forms as
// Tana). Pure; no DOM.
//
// Meant for "ask an AI to print the place in a fixed form, then copy and paste
// it". Accepted:
//   ssh://[user@]host[:22][/path]   the canonical form (sftp:// and remote:// too)
//   [user@]host:/abs/path           the scp-like short form (host:~/x too). A
//                                   relative path is not taken, so that
//                                   "localhost:8080" or a time is not misread
// The path comes out as "/abs", "~/x" or "" (= home). The URL form is
// %-decoded and may contain spaces; a trailing `#...` / `?...` is ignored.
// Surrounding spaces, quotes, backticks and <>, a leading list marker and ```
// fence lines are dropped, and the first line that reads is used. A port other
// than 22 is refused: name a Host in ~/.ssh/config instead.

const URL_RE =
  /^(?:ssh|sftp|remote):\/\/(?:([^@/\s]+)@)?([^/:\s#?]+)(?::(\d+))?(\/[^#?]*)?(?:[?#]\S*)?$/i;
// The host has 2+ characters so a drive ("C:\x", "C:/x") is not taken.
// The path is the rest of the line (spaces allowed) and starts with "/" or "~"
// (so a sentence like "Note: ..." is not taken).
const SCP_RE = /^(?:([^@\s:/\\]+)@)?([A-Za-z0-9][A-Za-z0-9._-]+):((?:\/(?!\/)|~)[^\\]*)$/;
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const USER_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;

function decode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Drop the decoration around a line (quotes, backticks, <>, list markers). */
function stripLine(line) {
  let s = String(line).trim();
  s = s.replace(/^(?:[-*•]\s+|\d+[.)]\s+)/, '');
  for (;;) {
    const t = s
      .replace(/^[`'"<「『]+/, '')
      .replace(/[`'">」』]+$/, '')
      .trim();
    if (t === s) return s;
    s = t;
  }
}

/** The path of the URL form ("/~/x" -> "~/x", "/~" -> "~", none -> ""). */
function urlPath(p) {
  if (!p || p === '') return '';
  const d = decode(p);
  if (d === '/~' || d === '/~/') return '~';
  if (d.startsWith('/~/')) return d.slice(1);
  return d;
}

function build(user, host, port, path) {
  if (!HOST_RE.test(host) || host.length > 253) return null;
  if (user && !USER_RE.test(user)) return null;
  if (port && port !== '22') {
    return {
      error: `ポート ${port} は直接指定できません。~/.ssh/config に Host を作り、その名前で指定してください`,
    };
  }
  return { host: user ? `${user}@${host}` : host, path };
}

/**
 * Read a one-line remote place.
 * @param {string} text what was pasted (the first line that reads, if several)
 * @returns {{host: string, path: string} | {error: string} | null}
 *   host is the ssh destination (may be user@host); path is "/abs", "~/x" or
 *   "" (home). null when the text is not a remote place.
 */
export function parseRemoteSpec(text) {
  if (typeof text !== 'string') return null;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) continue;
    const s = stripLine(raw);
    if (!s) continue;
    let m = URL_RE.exec(s);
    if (m) return build(m[1], m[2], m[3], urlPath(m[4]));
    m = SCP_RE.exec(s);
    if (m) return build(m[1], m[2], null, m[3]);
  }
  return null;
}

/** Write the canonical form (ssh://host/path). */
export function formatRemoteSpec(host, path = '') {
  const p = !path ? '' : path.startsWith('/') ? path : `/${path}`;
  return `ssh://${host}${p}`;
}

/**
 * What to put in the "open path" field from the clipboard text: the canonical
 * form of a remote place, or null (keep the usual default) when the text is
 * not one or is refused.
 */
export function prefillFromClipboard(text) {
  const r = parseRemoteSpec(text);
  return r && !r.error ? formatRemoteSpec(r.host, r.path) : null;
}
