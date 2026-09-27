// cli.js - Argument parsing and startup validation for scripts/serve.js.
//
// Kept pure (no fs, no process) so every refusal rule can be tested directly.
// Reading a key file or stdin, and generating certificates, happen in serve.js
// once this has said the combination is allowed.

const net = require('net');
const path = require('path');

const guard = require('./guard');
const netaccess = require('./netaccess');

const MIN_KEY_LENGTH = 16;
const DEFAULT_PORT = 3000;
const DEFAULT_HOST = '127.0.0.1';

const USAGE = `Fude browser mode

  fude-browser [options]

Local (default) — reachable only from this machine:
  fude-browser

Expose to a network range — all three are required together:
  fude-browser --listen 0.0.0.0 --allow 192.168.1.0/24 --root ~/notes

Options:
  -l, --listen <addr>     Address to bind (default ${DEFAULT_HOST})
  -p, --port <n>          Port (default ${DEFAULT_PORT})
      --allow <ranges>    Comma-separated CIDRs or presets that may connect.
                          Presets: lan, tailscale, localhost
                          Required when --listen is not loopback.
      --root <dir>        Confine all file access to this directory.
                          Required when --listen is not loopback.
      --key <value>       Access key for remote clients (min ${MIN_KEY_LENGTH} chars).
                          WARNING: visible to other users via 'ps'.
      --key-file <path>   Read the key from a file instead.
      --key -             Read the key from stdin.
                          Omit all of these to have one generated and shown once.
      --allowed-hosts <h> Extra hostnames accepted in the Host header.
      --hostname <name>   Hostname to put in the printed URL (default: localhost,
                          or the listen addresses when remote). Also accepted
                          in the Host header. E.g. fude.localhost, so browser
                          extensions can tell Fude apart from other local apps.
      --open-dir <dir>    Directory to open on startup.
      --tls / --no-tls    Force TLS on or off (default: on when remote).
      --tls-cert <path>   Certificate to use instead of the generated one.
      --tls-key <path>    Private key for --tls-cert.
      --i-know-what-im-doing
                          Allow a remote bind without --root.
  -h, --help              Show this help.

Environment: FUDE_HOST FUDE_PORT FUDE_ALLOW FUDE_ROOT FUDE_KEY
             FUDE_ALLOWED_HOSTS FUDE_HOSTNAME FUDE_OPEN_DIR FUDE_DIST_DIR
             (options override these; e.g. set FUDE_HOSTNAME=fude.localhost
             in your shell profile to make it the default)
`;

const FLAGS = new Set(['--tls', '--no-tls', '--i-know-what-im-doing', '-h', '--help']);

const ALIASES = {
  '-l': '--listen',
  '-p': '--port',
  '-h': '--help',
  '--host': '--listen',
};

const VALUED = new Set([
  '--listen',
  '--port',
  '--allow',
  '--root',
  '--key',
  '--key-file',
  '--allowed-hosts',
  '--hostname',
  '--open-dir',
  '--tls-cert',
  '--tls-key',
]);

function fail(error) {
  return { ok: false, error };
}

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME_RE = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})*$`);

/**
 * Validate a --hostname value: a DNS name or an IP address, nothing else (no
 * scheme, port or path — it goes into a URL and into the Host allow-list).
 * @param {string} value
 * @returns {{ok: true, hostname: string} | {ok: false, error: string}}
 */
function parseHostname(value) {
  const v = String(value).trim().toLowerCase();
  const bare = v.startsWith('[') && v.endsWith(']') ? v.slice(1, -1) : v;
  if (net.isIP(bare)) return { ok: true, hostname: bare };
  if (HOSTNAME_RE.test(v)) return { ok: true, hostname: v };
  return {
    ok: false,
    error:
      `Invalid --hostname: ${value}\n` +
      `Give just a host name or address, without scheme, port or path. For example:\n\n` +
      `  --hostname fude.localhost`,
  };
}

/**
 * Names the generated TLS certificate must cover: this machine's addresses,
 * plus every host name the user said they will open it by (--hostname,
 * --allowed-hosts). Without those names a browser reports a name mismatch on
 * top of the self-signed warning — and on HSTS-preloaded domains it will not
 * let the user proceed at all.
 *
 * Names go into an openssl -addext argument, so only well-formed host names
 * and IPs are passed through (a comma would smuggle in extra SAN entries).
 *
 * @param {string[]} addresses local interface addresses
 * @param {{urlHost?: string|null, allowedHosts?: string[]}} cfg
 * @returns {string[]}
 */
function certHosts(addresses, { urlHost = null, allowedHosts = [] } = {}) {
  const out = [];
  const add = (h) => {
    if (h && !out.includes(h)) out.push(h);
  };
  for (const a of addresses) add(a);
  for (const name of [urlHost, ...allowedHosts]) {
    if (!name) continue;
    const parsed = parseHostname(name);
    if (parsed.ok) add(parsed.hostname);
  }
  return out;
}

/**
 * The URLs to print at startup, in order.
 *
 * With a hostname configured it comes first: that is the address the user
 * asked to see. Otherwise loopback prints "localhost", and a remote bind every
 * address a client can reach it on.
 *
 * @param {{scheme: string, port: number, key: string, remote: boolean,
 *   urlHost?: string|null, addresses?: string[]}} p
 * @returns {string[]}
 */
function startupUrls({ scheme, port, key, remote, urlHost = null, addresses = [] }) {
  const format = (host) => {
    const hostPart = host.includes(':') ? `[${host}]` : host;
    return `${scheme}://${hostPart}:${port}/?token=${key}`;
  };
  if (!remote) return [format(urlHost || 'localhost')];
  const hosts = urlHost ? [urlHost, ...addresses.filter((a) => a !== urlHost)] : addresses;
  return hosts.map(format);
}

/**
 * @param {string[]} argv  Arguments after `node serve.js`.
 * @param {object}   env   Environment (defaults come from here).
 */
function parseArgs(argv = [], env = {}) {
  const raw = {};

  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (!arg.startsWith('-')) {
      return fail(`Unexpected argument: ${arg}\n\n${USAGE}`);
    }

    // --key=value is as natural to type as --key value.
    let inlineValue = null;
    const eq = arg.indexOf('=');
    if (eq !== -1 && !FLAGS.has(arg)) {
      inlineValue = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    arg = ALIASES[arg] || arg;

    if (FLAGS.has(arg)) {
      raw[arg] = true;
      continue;
    }
    if (!VALUED.has(arg)) {
      return fail(`Unknown option: ${arg}\n\n${USAGE}`);
    }
    const value = inlineValue !== null ? inlineValue : argv[++i];
    if (value === undefined) {
      return fail(`Option ${arg} needs a value`);
    }
    raw[arg] = value;
  }

  if (raw['--help']) return { ok: true, help: true, usage: USAGE };

  // ── Basics ────────────────────────────────────────────────
  const host = raw['--listen'] ?? env.FUDE_HOST ?? DEFAULT_HOST;
  const portRaw = raw['--port'] ?? env.FUDE_PORT ?? String(DEFAULT_PORT);
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return fail(`Invalid port: ${portRaw}`);
  }

  const remote = !guard.isLoopbackHost(host);
  const allowSpec = raw['--allow'] ?? env.FUDE_ALLOW ?? '';
  const rootRaw = raw['--root'] ?? env.FUDE_ROOT ?? '';
  const override = raw['--i-know-what-im-doing'] === true;

  // ── Remote requires an explicit range ─────────────────────
  if (remote && !allowSpec) {
    return fail(
      `--allow is required when listening on a non-loopback address (${host}).\n` +
        `This API can read and write your files, so the set of machines that may\n` +
        `reach it has to be stated explicitly. For example:\n\n` +
        `  fude-browser --listen ${host} --allow 192.168.1.0/24 --root ~/notes\n\n` +
        `Presets: lan, tailscale, localhost`,
    );
  }

  const { cidrs, invalid } = netaccess.parseAllowSpec(allowSpec);
  if (invalid.length > 0) {
    return fail(`Invalid --allow entry: ${invalid.join(', ')}`);
  }
  if (allowSpec && cidrs.length === 0) {
    return fail(`--allow did not resolve to any range: ${allowSpec}`);
  }

  // ── Remote requires a confined root ───────────────────────
  if (remote && !rootRaw && !override) {
    return fail(
      `--root is required when listening on a non-loopback address (${host}).\n` +
        `Without it, anyone holding the key can read and write anything you can.\n\n` +
        `  fude-browser --listen ${host} --allow ${allowSpec} --root ~/notes\n\n` +
        `To expose your whole home directory anyway:\n` +
        `  --root ~ --i-know-what-im-doing`,
    );
  }

  // ── Key ───────────────────────────────────────────────────
  let keySource;
  if (raw['--key'] !== undefined && raw['--key-file'] !== undefined) {
    return fail('Use either --key or --key-file, not both');
  }
  if (raw['--key'] === '-') {
    keySource = { type: 'stdin' };
  } else if (raw['--key'] !== undefined) {
    if (raw['--key'].length < MIN_KEY_LENGTH) {
      return fail(
        `--key must be at least ${MIN_KEY_LENGTH} characters (got ${raw['--key'].length}).\n` +
          `A short key is guessable by anyone inside --allow. Try:\n\n` +
          `  --key "$(openssl rand -hex 24)"\n\n` +
          `or omit --key entirely and let one be generated.`,
      );
    }
    keySource = { type: 'literal', value: raw['--key'] };
  } else if (raw['--key-file'] !== undefined) {
    keySource = { type: 'file', path: raw['--key-file'] };
  } else if (env.FUDE_KEY) {
    if (env.FUDE_KEY.length < MIN_KEY_LENGTH) {
      return fail(`FUDE_KEY must be at least ${MIN_KEY_LENGTH} characters`);
    }
    keySource = { type: 'env', value: env.FUDE_KEY };
  } else {
    keySource = { type: 'auto' };
  }

  // ── TLS ───────────────────────────────────────────────────
  if (raw['--tls'] && raw['--no-tls']) {
    return fail('Use either --tls or --no-tls, not both');
  }
  if ((raw['--tls-cert'] === undefined) !== (raw['--tls-key'] === undefined)) {
    return fail('--tls-cert and --tls-key must be given together');
  }
  // On by default for remote (the key travels over the wire), off for loopback
  // (where a self-signed cert buys nothing but a browser warning).
  let tlsEnabled = remote;
  if (raw['--tls']) tlsEnabled = true;
  if (raw['--no-tls']) tlsEnabled = false;
  if (raw['--tls-cert'] !== undefined && !raw['--no-tls']) tlsEnabled = true;

  const allowedHosts = String(raw['--allowed-hosts'] ?? env.FUDE_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);

  // ── Hostname for the printed URL ──────────────────────────
  let urlHost = null;
  // Blank (e.g. FUDE_HOSTNAME= to switch a profile default off) means unset.
  const hostnameRaw = String(raw['--hostname'] ?? env.FUDE_HOSTNAME ?? '').trim();
  if (hostnameRaw) {
    const parsed = parseHostname(hostnameRaw);
    if (!parsed.ok) return fail(parsed.error);
    urlHost = parsed.hostname;
    // The user will open this name, so the Host check must let it through.
    // (IPs and *.localhost pass anyway; adding them is harmless.)
    if (!allowedHosts.some((h) => h.toLowerCase() === urlHost)) allowedHosts.push(urlHost);
  }

  return {
    ok: true,
    config: {
      host,
      port,
      remote,
      allowSpec,
      allowCidrs: cidrs,
      root: rootRaw ? path.resolve(rootRaw) : '',
      rootOverride: override,
      keySource,
      tls: {
        enabled: tlsEnabled,
        certPath: raw['--tls-cert'],
        keyPath: raw['--tls-key'],
      },
      allowedHosts,
      urlHost,
      openDir: raw['--open-dir'] ?? env.FUDE_OPEN_DIR ?? '',
      distDir: env.FUDE_DIST_DIR || '',
    },
  };
}

module.exports = {
  parseArgs,
  parseHostname,
  startupUrls,
  certHosts,
  USAGE,
  MIN_KEY_LENGTH,
  DEFAULT_PORT,
  DEFAULT_HOST,
};
