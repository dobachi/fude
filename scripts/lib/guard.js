// guard.js - Security policy for browser mode (scripts/serve.js).
//
// Browser mode exposes the same filesystem power as the Tauri backend, but over
// HTTP. Before this module existed the server bound to every interface with no
// authentication, so anyone on the same Wi-Fi could read and write any path the
// user could. These are the pure decision functions that close that hole; they
// take plain values and return plain values so they can be tested without
// standing up a socket.

const crypto = require('crypto');
const net = require('net');
const path = require('path');

const TOKEN_HEADER = 'x-fude-token';

/**
 * Constant-time string comparison.
 *
 * Both sides are hashed first so that inputs of different lengths can still be
 * compared without `timingSafeEqual` throwing (and without leaking the expected
 * length through the exception).
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Pull the auth token out of a request: header first, then `?token=`. */
function extractToken(req) {
  const headers = req.headers || {};
  const direct = headers[TOKEN_HEADER];
  if (typeof direct === 'string' && direct) return direct;

  const auth = headers.authorization;
  if (typeof auth === 'string' && /^Bearer /i.test(auth)) {
    return auth.slice(7).trim();
  }

  try {
    const url = new URL(req.url || '/', 'http://fude.invalid');
    const q = url.searchParams.get('token');
    if (q) return q;
  } catch {
    /* malformed URL -> no token */
  }
  return null;
}

/**
 * Is the `Host` header one we are willing to answer API calls for?
 *
 * DNS rebinding needs a *name* that the attacker controls, so IP literals are
 * always fine (they cannot be rebound) and `localhost` is fine. Any other name
 * must be opted into explicitly, which is what a reverse proxy or a Tailscale
 * MagicDNS name would need.
 */
function isHostAllowed(hostHeader, extraAllowed = []) {
  if (typeof hostHeader !== 'string' || !hostHeader) return false;

  let hostname;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname;
  } catch {
    return false;
  }
  if (!hostname) return false;

  // `new URL` keeps IPv6 literals bracketed; strip them for net.isIP().
  const bare = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  if (net.isIP(bare)) return true;

  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost')) return true;

  return extraAllowed.some((h) => h.toLowerCase() === lower);
}

/**
 * Reject cross-site requests by requiring `Origin` (when the browser sends one)
 * to match the host the request was addressed to. Non-browser clients such as
 * curl send no Origin and are allowed through on the strength of the token.
 */
function isOriginAllowed(originHeader, hostHeader) {
  if (!originHeader || originHeader === 'null') return true;
  let originHost;
  try {
    originHost = new URL(originHeader).host;
  } catch {
    return false;
  }
  return originHost.toLowerCase() === String(hostHeader || '').toLowerCase();
}

/**
 * Decide whether an `/api/*` request may run.
 *
 * Returns `{ ok: true }` or `{ ok: false, status, error }`. The order matters:
 * host and origin are structural checks that should not depend on whether the
 * caller guessed the token.
 *
 * Two credentials exist, and which ones count depends on where the request came
 * from:
 *
 * - `token` is the local token, persisted in ~/.config/fude. It is accepted
 *   only over loopback.
 * - `remoteKey` is the key supplied at launch for `--allow`ed networks. It is
 *   never persisted and is the ONLY credential a remote client can use.
 *
 * Keeping them apart matters: if the persisted local token also opened the door
 * from the network, then one leak of a long-lived, on-disk secret would be a
 * permanent remote grant.
 */
function authorizeApi(req, { token, remoteKey, isLoopback = true, allowedHosts = [] } = {}) {
  const headers = req.headers || {};

  if (!isHostAllowed(headers.host, allowedHosts)) {
    return { ok: false, status: 403, error: 'Host not allowed' };
  }
  if (!isOriginAllowed(headers.origin, headers.host)) {
    return { ok: false, status: 403, error: 'Cross-origin request rejected' };
  }

  const accepted = [];
  if (isLoopback && token) accepted.push(token);
  if (remoteKey) accepted.push(remoteKey);

  if (accepted.length === 0) {
    return {
      ok: false,
      status: isLoopback ? 500 : 401,
      error: isLoopback ? 'Server has no auth token configured' : 'Missing or invalid key',
    };
  }

  const provided = extractToken(req);
  // Compare against every acceptable credential rather than short-circuiting,
  // so the time taken does not reveal which one matched.
  let matched = false;
  for (const candidate of accepted) {
    if (provided && safeEqual(provided, candidate)) matched = true;
  }
  if (!matched) {
    return {
      ok: false,
      status: 401,
      error: isLoopback ? 'Missing or invalid token' : 'Missing or invalid key',
    };
  }
  return { ok: true };
}

/**
 * Map a request URL to a file inside `distDir`, or null if it escapes.
 *
 * `path.join(distDir, req.url)` was enough to serve `/etc/passwd` with enough
 * `../` segments, so the resolved path is checked against the root prefix.
 */
function resolveStaticPath(distDir, reqUrl) {
  const root = path.resolve(distDir);

  let pathname;
  try {
    pathname = new URL(reqUrl || '/', 'http://fude.invalid').pathname;
    pathname = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0')) return null;

  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const resolved = path.resolve(root, rel);

  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

/**
 * Confine a filesystem path handed to an API command.
 *
 * With no root configured every path is allowed, matching the Tauri app, which
 * can open anything the user can. Setting one (FUDE_ROOT) is the safety belt for
 * the case where the server is deliberately bound to a non-loopback address.
 */
function isPathAllowed(targetPath, root) {
  if (!root) return true;
  if (typeof targetPath !== 'string' || !targetPath) return false;
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(targetPath);
  return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
}

/** True for addresses that only the local machine can reach. */
function isLoopbackHost(host) {
  if (!host) return false;
  const bare = host.startsWith('[') ? host.slice(1, -1) : host;
  const lower = bare.toLowerCase();
  if (lower === 'localhost') return true;
  if (lower === '::1') return true;
  return /^127\./.test(lower);
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = {
  TOKEN_HEADER,
  authorizeApi,
  extractToken,
  generateToken,
  isHostAllowed,
  isLoopbackHost,
  isOriginAllowed,
  isPathAllowed,
  resolveStaticPath,
  safeEqual,
};
