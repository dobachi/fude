#!/usr/bin/env node
// serve.js - Lightweight HTTP server for WSL/browser fallback mode
// Serves the frontend and provides REST API matching Tauri commands
//
// Security: the API below can read and write any path the user can, so it is
// bound to loopback by default and every /api/* call must carry the session
// token (see scripts/lib/guard.js). Set FUDE_HOST to bind elsewhere.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const cli = require('./lib/cli');
const guard = require('./lib/guard');
const netaccess = require('./lib/netaccess');
const selfsigned = require('./lib/selfsigned');

const DIST_DIR = process.env.FUDE_DIST_DIR || path.join(__dirname, '..', 'dist');
const CONFIG_DIR = path.join(os.homedir(), '.config', 'fude');
const TMP_DIR = path.join(CONFIG_DIR, 'tmp');
const TOKEN_FILE = path.join(CONFIG_DIR, 'browser-token');

// Settled by start() from the command line; the API handlers read them from
// here rather than from the environment so the same handlers serve a local and
// a remote instance.
const runtime = {
  openDir: process.env.FUDE_OPEN_DIR || '',
  root: '',
};

// Ensure directories exist
fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });

/**
 * The token that authenticates every API call.
 *
 * Persisted at 0600 so that restarting the server does not invalidate an open
 * tab or a bookmarked URL; FUDE_TOKEN overrides it for callers (fude-remote)
 * that need to know the value up front.
 */
function loadOrCreateToken() {
  if (process.env.FUDE_TOKEN) return process.env.FUDE_TOKEN;
  try {
    const existing = fs.readFileSync(TOKEN_FILE, 'utf-8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* no token yet */
  }
  const token = guard.generateToken();
  fs.writeFileSync(TOKEN_FILE, token, { encoding: 'utf-8', mode: 0o600 });
  try {
    fs.chmodSync(TOKEN_FILE, 0o600);
  } catch {
    /* best effort on filesystems without POSIX modes (e.g. /mnt/c) */
  }
  return token;
}

// MIME types
const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

// Hash function for temp file paths (matches Rust implementation)
function hashPath(str) {
  let hash = 0n;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5n) - hash + BigInt(str.charCodeAt(i))) & 0xffffffffffffffffn;
  }
  return hash.toString(16);
}

function tempFilePath(originalPath) {
  const hash = hashPath(originalPath);
  const fileName = path.basename(originalPath);
  return path.join(TMP_DIR, `${hash}_${fileName}`);
}

// Which argument of each command names a filesystem path, so FUDE_ROOT can be
// enforced in one place instead of inside every handler.
const PATH_ARGS = {
  read_file: ['path'],
  write_file: ['path'],
  read_dir_tree: ['path'],
  browse_dir: ['path'],
  write_temp_file: ['path'],
  delete_temp_file: ['path'],
  check_temp_files: ['paths'],
};

function checkPathArgs(cmdName, args, root) {
  if (!root) return null;
  const fields = PATH_ARGS[cmdName];
  if (!fields) return null;
  for (const field of fields) {
    const value = args[field];
    if (value === undefined || value === null || value === '') continue;
    const list = Array.isArray(value) ? value : [value];
    for (const p of list) {
      if (!guard.isPathAllowed(p, root)) {
        return `Path outside FUDE_ROOT: ${p}`;
      }
    }
  }
  return null;
}

// API handlers (match Tauri commands)
const api = {
  read_file({ path: filePath }) {
    return fs.readFileSync(filePath, 'utf-8');
  },

  write_file({ path: filePath, content }) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    return null;
  },

  // Tauri maps snake_case Rust params to camelCase JS keys, so the frontend
  // sends `showAllFiles`; older callers of this HTTP API send `show_all_files`.
  // Accept both — reading only one silently dropped "show all files" here.
  read_dir_tree({ path: dirPath, showAllFiles, show_all_files }) {
    const includeAll = showAllFiles ?? show_all_files ?? false;

    function scan(dir) {
      const entries = [];
      let items;
      try {
        items = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return entries;
      }

      // Sort: dirs first, then alphabetical
      items.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

      for (const item of items) {
        if (item.name.startsWith('.')) continue;
        const fullPath = path.join(dir, item.name);

        if (item.isDirectory()) {
          const children = scan(fullPath);
          if (children.length > 0) {
            const stat = fs.statSync(fullPath);
            entries.push({
              name: item.name,
              path: fullPath,
              is_dir: true,
              children,
              modified: stat.mtimeMs / 1000,
              created: stat.birthtimeMs / 1000,
              size: stat.size,
            });
          }
        } else if (includeAll || item.name.endsWith('.md')) {
          const stat = fs.statSync(fullPath);
          entries.push({
            name: item.name,
            path: fullPath,
            is_dir: false,
            children: null,
            modified: stat.mtimeMs / 1000,
            created: stat.birthtimeMs / 1000,
            size: stat.size,
          });
        }
      }
      return entries;
    }

    return scan(dirPath);
  },

  // Browse directory (shallow, for folder picker dialog)
  browse_dir({ path: dirPath }) {
    const target = dirPath || runtime.root || os.homedir();
    const entries = [];
    try {
      const items = fs.readdirSync(target, { withFileTypes: true });
      items.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });
      for (const item of items) {
        if (item.name.startsWith('.')) continue;
        entries.push({
          name: item.name,
          path: path.join(target, item.name),
          is_dir: item.isDirectory(),
        });
      }
    } catch { /* ignore */ }
    return { current: target, parent: path.dirname(target), entries };
  },

  // Get initial directory (set via FUDE_OPEN_DIR env)
  get_open_dir() {
    return runtime.openDir || null;
  },

  load_session() {
    const sessionPath = path.join(CONFIG_DIR, 'session.json');
    if (!fs.existsSync(sessionPath)) return null;
    return JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
  },

  save_session({ session }) {
    fs.writeFileSync(
      path.join(CONFIG_DIR, 'session.json'),
      JSON.stringify(session, null, 2),
      'utf-8',
    );
    return null;
  },

  get_config() {
    const configPath = path.join(CONFIG_DIR, 'config.json');
    let config = {
      theme: 'dark',
      features: { ai_copilot: false, diff_highlight: true },
      font_size: 14,
      vim_mode: false,
    };
    if (fs.existsSync(configPath)) {
      try {
        config = { ...config, ...JSON.parse(fs.readFileSync(configPath, 'utf-8')) };
      } catch { /* ignore */ }
    }
    const hasApiKey = !!(config.openrouter_api_key);
    // Return ConfigResponse format (matching Tauri backend)
    return {
      theme: config.theme,
      features: config.features,
      font_size: config.font_size,
      vim_mode: config.vim_mode,
      has_api_key: hasApiKey,
      api_key_storage: 'config',
      ai_model: config.ai_model || null,
      sidebar_sort: config.sidebar_sort || 'name_asc',
      sidebar_show_all_files: config.sidebar_show_all_files || false,
    };
  },

  save_config({ config }) {
    const configPath = path.join(CONFIG_DIR, 'config.json');
    // Preserve API key from existing config (it's managed separately via set_api_key)
    let existing = {};
    try {
      existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch { /* ignore */ }
    const toSave = { ...config };
    // Keep existing API key if not explicitly provided
    if (!toSave.openrouter_api_key && existing.openrouter_api_key) {
      toSave.openrouter_api_key = existing.openrouter_api_key;
    }
    // Remove ConfigResponse-only fields that shouldn't be persisted
    delete toSave.has_api_key;
    delete toSave.api_key_storage;
    fs.writeFileSync(configPath, JSON.stringify(toSave, null, 2), 'utf-8');
    return null;
  },

  set_api_key({ key }) {
    const configPath = path.join(CONFIG_DIR, 'config.json');
    let config = {};
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch { /* ignore */ }
    config.openrouter_api_key = key;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    return 'config';
  },

  delete_api_key() {
    const configPath = path.join(CONFIG_DIR, 'config.json');
    let config = {};
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch { /* ignore */ }
    delete config.openrouter_api_key;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    return null;
  },

  write_temp_file({ path: filePath, content }) {
    const tmp = tempFilePath(filePath);
    fs.writeFileSync(tmp, content, 'utf-8');
    return null;
  },

  delete_temp_file({ path: filePath }) {
    const tmp = tempFilePath(filePath);
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    return null;
  },

  check_temp_files({ paths }) {
    const results = [];
    for (const p of paths) {
      const tmp = tempFilePath(p);
      if (fs.existsSync(tmp)) {
        const stat = fs.statSync(tmp);
        results.push({
          original_path: p,
          temp_path: tmp,
          modified: String(stat.mtimeMs),
        });
      }
    }
    return results;
  },
};

// SSE handler for AI chat streaming
function handleAiChatStream(req, res) {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', async () => {
    let args;
    try {
      args = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const { messages, model } = args;

    // Read API key from config
    const configPath = path.join(CONFIG_DIR, 'config.json');
    let apiKey = '';
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      apiKey = cfg.openrouter_api_key || '';
    } catch { /* ignore */ }

    if (!apiKey) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'OpenRouter API key not configured' }));
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const abortController = new AbortController();
    let clientDisconnected = false;
    res.on('close', () => {
      clientDisconnected = true;
      abortController.abort();
    });

    try {
      const apiRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: model || 'openai/gpt-4o-mini',
          messages,
          stream: true,
        }),
        signal: abortController.signal,
      });

      if (!apiRes.ok) {
        const errBody = await apiRes.text();
        res.write(`data: ${JSON.stringify({ error: errBody })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      try {
        for await (const chunk of apiRes.body) {
          if (clientDisconnected) break;
          res.write(Buffer.from(chunk));
        }
      } catch (e) {
        if (e.name !== 'AbortError') {
          res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
          res.write('data: [DONE]\n\n');
        }
      }
      if (!clientDisconnected) res.end();
    } catch (err) {
      if (err.name !== 'AbortError' && !clientDisconnected) {
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }
    }
  });
}

// Non-streaming AI chat
api.ai_chat = function () {
  return { error: 'Use ai_chat_stream for AI requests' };
};

// Fetch available models from OpenRouter
api.ai_models = function () {
  const configPath = path.join(CONFIG_DIR, 'config.json');
  let apiKey = '';
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    apiKey = cfg.openrouter_api_key || '';
  } catch { /* ignore */ }

  if (!apiKey) return { data: [] };

  // Synchronous HTTP not practical; return fallback list
  // The model-picker.js handles this gracefully with its fallback
  return { data: [] };
};

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/**
 * Build the HTTP server. Exported so tests can drive it on an ephemeral port
 * without shelling out.
 */
function createFudeServer({
  token,
  remoteKey = '',
  allowCidrs = [],
  distDir = DIST_DIR,
  root = '',
  allowedHosts = [],
  tls = null,
  limiter = netaccess.createAttemptLimiter(),
  onReject = () => {},
} = {}) {
  const handler = (req, res) => {
    const clientIp = netaccess.normalizeIp(req.socket?.remoteAddress) || '';
    const loopback = netaccess.isLoopbackIp(clientIp);

    // Re-check the range here as well as at the socket, so a handler can never
    // be reached by a connection that slipped past the listener gate.
    if (!loopback && !netaccess.isRemoteAllowed(clientIp, allowCidrs)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    // No Access-Control-Allow-Origin: the UI is served from this same origin,
    // so nothing legitimate is cross-origin. Advertising `*` previously let any
    // web page the user visited read the response of these calls.
    res.setHeader('Vary', 'Origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const isApi = req.url && (req.url === '/api' || req.url.startsWith('/api/'));

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (isApi) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'Method not allowed' });
        return;
      }

      // An allowed range is not a trusted range. Lock out an address that keeps
      // guessing before spending any more work on it.
      if (!loopback) {
        const locked = limiter.check(clientIp);
        if (locked.locked) {
          res.setHeader('Retry-After', String(Math.ceil(locked.retryAfterMs / 1000)));
          sendJson(res, 429, { error: 'Too many failed attempts' });
          return;
        }
      }

      const verdict = guard.authorizeApi(req, {
        token,
        remoteKey,
        isLoopback: loopback,
        allowedHosts,
      });
      if (!verdict.ok) {
        if (!loopback && verdict.status === 401) {
          const result = limiter.recordFailure(clientIp);
          onReject(clientIp, result.locked ? 'locked out' : 'bad key');
        }
        sendJson(res, verdict.status, { error: verdict.error });
        return;
      }
      if (!loopback) limiter.recordSuccess(clientIp);
    }

    // SSE endpoint for AI streaming
    const urlPath = (req.url || '/').split('?')[0];
    if (req.method === 'POST' && urlPath === '/api/ai_chat_stream') {
      handleAiChatStream(req, res);
      return;
    }

    // API endpoints
    if (isApi) {
      const cmdName = urlPath.slice(5); // Remove '/api/'
      let body = '';
      let tooLarge = false;
      req.on('data', (chunk) => {
        body += chunk;
        // The editor posts whole documents, so the cap is generous; it exists
        // only so an unauthenticated-looking client cannot exhaust memory.
        if (body.length > 64 * 1024 * 1024) {
          tooLarge = true;
          req.destroy();
        }
      });
      req.on('end', () => {
        if (tooLarge) return;
        try {
          const args = body ? JSON.parse(body) : {};
          const handler = Object.prototype.hasOwnProperty.call(api, cmdName) ? api[cmdName] : null;
          if (!handler) {
            sendJson(res, 404, { error: `Unknown command: ${cmdName}` });
            return;
          }
          const pathError = checkPathArgs(cmdName, args, root);
          if (pathError) {
            sendJson(res, 403, { error: pathError });
            return;
          }
          const result = handler(args);
          sendJson(res, 200, result);
        } catch (err) {
          sendJson(res, 500, { error: err.message });
        }
      });
      return;
    }

    // Static files
    const filePath = guard.resolveStaticPath(distDir, req.url);
    if (!filePath) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    const ext = path.extname(filePath);
    const contentType = MIME[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    });
  };

  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);

  // Drop disallowed sources at the TCP layer, before any HTTP (or TLS
  // handshake) work. An address outside --allow gets no response at all, so the
  // port does not answer to a scan, and a flood costs us nothing to parse.
  if (allowCidrs.length > 0) {
    server.on('connection', (socket) => {
      const ip = netaccess.normalizeIp(socket.remoteAddress) || '';
      if (netaccess.isLoopbackIp(ip)) return;
      if (!netaccess.isRemoteAllowed(ip, allowCidrs)) {
        onReject(ip, 'not in --allow');
        socket.destroy();
      }
    });
  }

  return server;
}

/** Read a key from stdin, for `--key -` (keeps it out of `ps` and history). */
function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data.trim()));
    process.stdin.on('error', reject);
  });
}

/** Resolve the remote access key from whichever source the CLI selected. */
async function resolveRemoteKey(keySource) {
  switch (keySource.type) {
    case 'literal':
    case 'env':
      return { key: keySource.value, generated: false, fromArgv: keySource.type === 'literal' };
    case 'file': {
      const key = fs.readFileSync(keySource.path, 'utf-8').trim();
      if (key.length < cli.MIN_KEY_LENGTH) {
        throw new Error(
          `Key in ${keySource.path} must be at least ${cli.MIN_KEY_LENGTH} characters`,
        );
      }
      return { key, generated: false, fromArgv: false };
    }
    case 'stdin': {
      const key = await readStdin();
      if (key.length < cli.MIN_KEY_LENGTH) {
        throw new Error(`Key read from stdin must be at least ${cli.MIN_KEY_LENGTH} characters`);
      }
      return { key, generated: false, fromArgv: false };
    }
    default:
      // Not persisted: a remote grant should end when the process does.
      return { key: guard.generateToken(), generated: true, fromArgv: false };
  }
}

/** Addresses a client could actually type, given what we bound and allowed. */
function reachableAddresses(host, allowCidrs) {
  if (host !== '0.0.0.0' && host !== '::') return [host];
  const addrs = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      const ip = netaccess.normalizeIp(iface.address);
      if (!ip || netaccess.isLoopbackIp(ip)) continue;
      if (netaccess.isRemoteAllowed(ip, allowCidrs)) addrs.push(ip);
    }
  }
  return addrs.length > 0 ? addrs : [host];
}

function formatUrl(scheme, address, port, key) {
  const hostPart = address.includes(':') ? `[${address}]` : address;
  return `${scheme}://${hostPart}:${port}/?token=${key}`;
}

async function start(argv = process.argv.slice(2), env = process.env) {
  const parsed = cli.parseArgs(argv, env);
  if (!parsed.ok) {
    console.error(`\n${parsed.error}\n`);
    process.exitCode = 1;
    return null;
  }
  if (parsed.help) {
    console.log(parsed.usage);
    return null;
  }

  const cfg = parsed.config;
  runtime.openDir = cfg.openDir;
  runtime.root = cfg.root;

  const localToken = loadOrCreateToken();

  let remoteKey = '';
  let keyGenerated = false;
  let keyFromArgv = false;
  if (cfg.remote) {
    try {
      const resolved = await resolveRemoteKey(cfg.keySource);
      remoteKey = resolved.key;
      keyGenerated = resolved.generated;
      keyFromArgv = resolved.fromArgv;
    } catch (err) {
      console.error(`\n${err.message}\n`);
      process.exitCode = 1;
      return null;
    }
  }

  // ── TLS ──────────────────────────────────────────────────
  let tlsOptions = null;
  let fingerprint = '';
  let certGenerated = false;
  if (cfg.tls.enabled) {
    try {
      if (cfg.tls.certPath) {
        tlsOptions = {
          cert: fs.readFileSync(cfg.tls.certPath),
          key: fs.readFileSync(cfg.tls.keyPath),
        };
        fingerprint = selfsigned.fingerprint(cfg.tls.certPath);
      } else {
        const material = selfsigned.ensureCert({ configDir: CONFIG_DIR });
        tlsOptions = { cert: material.cert, key: material.key };
        fingerprint = material.fingerprint;
        certGenerated = material.generated;
      }
    } catch (err) {
      console.error(`\nTLS setup failed: ${err.message}\n`);
      process.exitCode = 1;
      return null;
    }
  }

  const rejectLog = new Map();
  const onReject = (ip, reason) => {
    // Throttle: a scanner should not be able to fill the terminal, but a
    // misconfigured --allow must still be visible to whoever started this.
    const now = Date.now();
    const last = rejectLog.get(ip) || 0;
    if (now - last < 60_000) return;
    rejectLog.set(ip, now);
    console.log(`  rejected ${ip} (${reason})`);
  };

  const server = createFudeServer({
    token: localToken,
    remoteKey,
    allowCidrs: cfg.allowCidrs,
    root: cfg.root,
    allowedHosts: cfg.allowedHosts,
    tls: tlsOptions,
    onReject,
  });

  const scheme = tlsOptions ? 'https' : 'http';

  server.listen(cfg.port, cfg.host, () => {
    console.log(`\n  Fude (browser mode) running at:\n`);

    if (!cfg.remote) {
      console.log(`    ${formatUrl(scheme, 'localhost', cfg.port, localToken)}\n`);
    } else {
      for (const addr of reachableAddresses(cfg.host, cfg.allowCidrs)) {
        console.log(`    ${formatUrl(scheme, addr, cfg.port, remoteKey)}`);
      }
      console.log('');
      console.log(`  Reachable from: ${cfg.allowCidrs.map((c) => c.source).join(', ')}`);
      console.log(
        `  File access:    ${cfg.root ? `confined to ${cfg.root}` : 'NOT CONFINED (--i-know-what-im-doing)'}`,
      );
      if (keyGenerated) {
        console.log(`  Key:            generated for this session; it is not saved anywhere.`);
      } else if (keyFromArgv) {
        console.log(`  Key:            WARNING - passed on the command line, so it is visible`);
        console.log(`                  to other users of this machine via 'ps'. Prefer`);
        console.log(`                  --key-file, --key - (stdin), or omitting --key.`);
      }
      if (fingerprint) {
        console.log(`  Certificate:    self-signed${certGenerated ? ' (newly generated)' : ''}.`);
        console.log(`                  Your browser will warn once. Check this first:`);
        console.log(`                  SHA-256 ${fingerprint}`);
      } else {
        console.log(`  WARNING:        TLS is off, so the key and your documents travel`);
        console.log(`                  in the clear. Use an SSH tunnel or Tailscale.`);
      }
      console.log('');
    }
    console.log(`  Press Ctrl+C to stop.\n`);
  });
  return server;
}

if (require.main === module) {
  start();
}

module.exports = {
  createFudeServer,
  loadOrCreateToken,
  start,
  api,
  checkPathArgs,
  PATH_ARGS,
  reachableAddresses,
  runtime,
};
