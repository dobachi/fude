// netaccess.js - Who is allowed to connect, and how often they may guess.
//
// Browser mode can be opened to a network range (`--allow`). That makes the
// source address a security boundary, so the matching has to be exact: no
// X-Forwarded-For (a remote client controls it), and IPv4-mapped IPv6 has to
// normalise or a `192.168.1.0/24` rule silently fails to match a client that
// arrived over a dual-stack socket as `::ffff:192.168.1.5`.
//
// Pure functions plus one small stateful limiter with an injectable clock.

const net = require('net');

// Presets so people do not have to remember RFC 1918 by heart.
const PRESETS = {
  localhost: ['127.0.0.0/8', '::1/128'],
  lan: [
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '169.254.0.0/16', // link-local
    'fc00::/7', // unique local
    'fe80::/10', // link-local
  ],
  tailscale: ['100.64.0.0/10', 'fd7a:115c:a1e0::/48'],
};

function ipv4ToBigInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n << 8n) | BigInt(v);
  }
  return n;
}

function ipv6ToBigInt(ip) {
  let s = ip;

  // A trailing dotted quad (::ffff:192.168.1.5) becomes two hex groups.
  const v4Match = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Match) {
    const v4 = ipv4ToBigInt(v4Match[1]);
    if (v4 === null) return null;
    const hi = (v4 >> 16n) & 0xffffn;
    const lo = v4 & 0xffffn;
    s = s.slice(0, s.length - v4Match[1].length) + hi.toString(16) + ':' + lo.toString(16);
  }

  let groups;
  const doubleColon = s.indexOf('::');
  if (doubleColon === -1) {
    groups = s.split(':');
    if (groups.length !== 8) return null;
  } else {
    if (s.indexOf('::', doubleColon + 1) !== -1) return null; // only one '::' allowed
    const head = s.slice(0, doubleColon).split(':').filter((g) => g !== '');
    const tail = s.slice(doubleColon + 2).split(':').filter((g) => g !== '');
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill('0'), ...tail];
  }

  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

/**
 * Collapse an address to its canonical comparable form.
 *
 * Node reports an IPv4 client on a dual-stack listener as `::ffff:192.168.1.5`.
 * Without this, an IPv4 `--allow` rule would never match that client and the
 * feature would look like it "randomly" rejects phones.
 */
function normalizeIp(ip) {
  if (typeof ip !== 'string' || !ip) return null;
  let s = ip.trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const pct = s.indexOf('%'); // strip zone id (fe80::1%eth0)
  if (pct !== -1) s = s.slice(0, pct);

  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped && net.isIP(mapped[1]) === 4) return mapped[1];

  const version = net.isIP(s);
  if (version === 0) return null;
  return s;
}

function ipToBigInt(ip) {
  const version = net.isIP(ip);
  if (version === 4) return ipv4ToBigInt(ip);
  if (version === 6) return ipv6ToBigInt(ip);
  return null;
}

/** Parse "192.168.1.0/24" or a bare address (treated as a single host). */
function parseCidr(spec) {
  if (typeof spec !== 'string' || !spec.trim()) return null;
  const s = spec.trim();
  const slash = s.lastIndexOf('/');
  const addrPart = slash === -1 ? s : s.slice(0, slash);
  const addr = normalizeIp(addrPart);
  if (!addr) return null;

  const version = net.isIP(addr);
  const maxBits = version === 4 ? 32 : 128;

  let bits;
  if (slash === -1) {
    bits = maxBits;
  } else {
    const raw = s.slice(slash + 1);
    if (!/^\d{1,3}$/.test(raw)) return null;
    bits = Number(raw);
    if (bits > maxBits) return null;
  }

  const value = ipToBigInt(addr);
  if (value === null) return null;

  // Mask off host bits so 192.168.1.5/24 behaves as 192.168.1.0/24.
  const shift = BigInt(maxBits - bits);
  const base = (value >> shift) << shift;
  return { version, base, bits, maxBits };
}

function ipInCidr(ip, cidr) {
  const addr = normalizeIp(ip);
  if (!addr || !cidr) return false;
  const version = net.isIP(addr);
  if (version !== cidr.version) return false;
  const value = ipToBigInt(addr);
  if (value === null) return false;
  const shift = BigInt(cidr.maxBits - cidr.bits);
  return (value >> shift) << shift === cidr.base;
}

/**
 * Turn a user-supplied `--allow` string into CIDRs.
 *
 * Returns `{ cidrs, invalid }`; the caller refuses to start if anything is
 * invalid rather than silently narrowing (or widening) what was asked for.
 */
function parseAllowSpec(spec) {
  const cidrs = [];
  const invalid = [];
  const seen = new Set();

  const tokens = String(spec || '')
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  for (const token of tokens) {
    const preset = PRESETS[token.toLowerCase()];
    const items = preset || [token];
    for (const item of items) {
      const cidr = parseCidr(item);
      if (!cidr) {
        invalid.push(token);
        break;
      }
      const key = `${cidr.version}/${cidr.base}/${cidr.bits}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cidrs.push({ ...cidr, source: item });
    }
  }
  return { cidrs, invalid };
}

function isRemoteAllowed(ip, cidrs) {
  if (!Array.isArray(cidrs) || cidrs.length === 0) return false;
  return cidrs.some((c) => ipInCidr(ip, c));
}

const LOOPBACK = [parseCidr('127.0.0.0/8'), parseCidr('::1/128')];

function isLoopbackIp(ip) {
  return LOOPBACK.some((c) => ipInCidr(ip, c));
}

/**
 * Per-IP failure lockout.
 *
 * An allowed range is not a trusted range — a /24 of café Wi-Fi is still a /24.
 * Without this, the key is only as strong as how long an attacker is willing to
 * sit on the network. Backoff doubles per lockout so repeat offenders fall off
 * quickly while a user who fat-fingers the key once is barely inconvenienced.
 */
function createAttemptLimiter({
  maxFailures = 5,
  baseLockoutMs = 15 * 60 * 1000,
  maxLockoutMs = 24 * 60 * 60 * 1000,
  now = Date.now,
} = {}) {
  const state = new Map();

  function entryFor(ip) {
    let e = state.get(ip);
    if (!e) {
      e = { failures: 0, lockedUntil: 0, lockouts: 0 };
      state.set(ip, e);
    }
    return e;
  }

  return {
    /** `{ locked: false }` or `{ locked: true, retryAfterMs }`. */
    check(ip) {
      const e = state.get(ip);
      if (!e) return { locked: false };
      const t = now();
      if (e.lockedUntil > t) return { locked: true, retryAfterMs: e.lockedUntil - t };
      return { locked: false };
    },

    recordFailure(ip) {
      const e = entryFor(ip);
      const t = now();
      if (e.lockedUntil > t) return { locked: true, retryAfterMs: e.lockedUntil - t };

      e.failures += 1;
      if (e.failures >= maxFailures) {
        const ms = Math.min(baseLockoutMs * 2 ** e.lockouts, maxLockoutMs);
        e.lockouts += 1;
        e.failures = 0;
        e.lockedUntil = t + ms;
        return { locked: true, retryAfterMs: ms };
      }
      return { locked: false, remaining: maxFailures - e.failures };
    },

    recordSuccess(ip) {
      // Keep the lockout counter: a successful guess should not wipe the
      // history of how hard this address has been trying.
      const e = state.get(ip);
      if (e) e.failures = 0;
    },

    reset(ip) {
      if (ip === undefined) state.clear();
      else state.delete(ip);
    },

    size() {
      return state.size;
    },
  };
}

module.exports = {
  PRESETS,
  createAttemptLimiter,
  ipInCidr,
  ipToBigInt,
  isLoopbackIp,
  isRemoteAllowed,
  normalizeIp,
  parseAllowSpec,
  parseCidr,
};
