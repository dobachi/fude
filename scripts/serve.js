#!/usr/bin/env node
// serve.js - Lightweight HTTP server for WSL/browser fallback mode
// Serves the frontend and provides REST API matching Tauri commands

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = parseInt(process.env.FUDE_PORT || '3000', 10);
const DIST_DIR = process.env.FUDE_DIST_DIR || path.join(__dirname, '..', 'dist');
const CONFIG_DIR = path.join(os.homedir(), '.config', 'fude');
const TMP_DIR = path.join(CONFIG_DIR, 'tmp');
const OPEN_DIR = process.env.FUDE_OPEN_DIR || '';

// Ensure directories exist
fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });

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

  read_dir_tree({ path: dirPath }) {
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
            entries.push({
              name: item.name,
              path: fullPath,
              is_dir: true,
              children,
            });
          }
        } else if (item.name.endsWith('.md')) {
          entries.push({
            name: item.name,
            path: fullPath,
            is_dir: false,
            children: null,
          });
        }
      }
      return entries;
    }

    return scan(dirPath);
  },

  // Browse directory (shallow, for folder picker dialog)
  browse_dir({ path: dirPath }) {
    const target = dirPath || os.homedir();
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
    return OPEN_DIR || null;
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
    if (!fs.existsSync(configPath)) {
      return {
        theme: 'dark',
        features: { ai_copilot: false, diff_highlight: true },
        font_size: 14,
        vim_mode: false,
        openrouter_api_key: null,
      };
    }
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  },

  save_config({ config }) {
    fs.writeFileSync(
      path.join(CONFIG_DIR, 'config.json'),
      JSON.stringify(config, null, 2),
      'utf-8',
    );
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
api.ai_chat = function ({ messages, model }) {
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

// HTTP Server
const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // SSE endpoint for AI streaming
  if (req.method === 'POST' && req.url === '/api/ai_chat_stream') {
    handleAiChatStream(req, res);
    return;
  }

  // API endpoints
  if (req.method === 'POST' && req.url.startsWith('/api/')) {
    const cmdName = req.url.slice(5); // Remove '/api/'
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        const args = body ? JSON.parse(body) : {};
        const handler = api[cmdName];
        if (!handler) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Unknown command: ${cmdName}` }));
          return;
        }
        const result = handler(args);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Static files
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(DIST_DIR, filePath);

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
});

server.listen(PORT, () => {
  console.log(`\n  Fude (browser mode) running at:\n`);
  console.log(`    http://localhost:${PORT}\n`);
  console.log(`  Press Ctrl+C to stop.\n`);
});
