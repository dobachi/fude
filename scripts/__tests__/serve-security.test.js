// @vitest-environment node
//
// Replays the attack that browser mode used to allow: an unauthenticated
// request from another machine on the LAN reading and writing arbitrary paths.
// These drive a real server over a real socket, so a regression in the wiring
// (not just in guard.js) fails here.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOKEN = 'f'.repeat(64);

let createFudeServer;
let server;
let port;
let tmpDir;
let distDir;
let secretFile;

/** Minimal HTTP client: no fetch, so nothing normalises our hostile paths. */
function request({ method = 'POST', urlPath, headers = {}, body, rawPath = false, to }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: to ?? port,
        method,
        path: urlPath,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        // Node's client does not rewrite `path`, so `../` reaches the server
        // exactly as an attacker would send it.
        setHost: !rawPath,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fude-sec-'));
  distDir = path.join(tmpDir, 'dist');
  fs.mkdirSync(distDir);
  fs.writeFileSync(path.join(distDir, 'index.html'), '<html>fude</html>');

  secretFile = path.join(tmpDir, 'secret.txt');
  fs.writeFileSync(secretFile, 'TOP SECRET');

  process.env.FUDE_TOKEN = TOKEN;
  ({ createFudeServer } = await import('../serve.js'));
  server = createFudeServer({ token: TOKEN, distDir, root: '' });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  delete process.env.FUDE_TOKEN;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const auth = () => ({ 'X-Fude-Token': TOKEN });

describe('binding', () => {
  // The original hole was `server.listen(PORT)` with no host, which binds
  // 0.0.0.0 and put the filesystem API on every interface.
  it('defaults to loopback', async () => {
    const cli = (await import('../lib/cli.js')).default;
    const parsed = cli.parseArgs([], {});
    expect(parsed.ok).toBe(true);
    expect(parsed.config.host).toBe('127.0.0.1');
    expect(parsed.config.remote).toBe(false);
  });

  it('cannot be moved off loopback without saying who may connect', async () => {
    const cli = (await import('../lib/cli.js')).default;
    expect(cli.parseArgs(['--listen', '0.0.0.0'], {}).ok).toBe(false);
    expect(cli.parseArgs([], { FUDE_HOST: '0.0.0.0' }).ok).toBe(false);
  });
});

describe('unauthenticated API access', () => {
  it('refuses read_file without a token', async () => {
    const res = await request({ urlPath: '/api/read_file', body: { path: secretFile } });
    expect(res.status).toBe(401);
    expect(res.body).not.toContain('TOP SECRET');
  });

  it('refuses write_file without a token', async () => {
    const target = path.join(tmpDir, 'pwned.txt');
    const res = await request({
      urlPath: '/api/write_file',
      body: { path: target, content: 'owned' },
    });
    expect(res.status).toBe(401);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('refuses browse_dir (home directory listing) without a token', async () => {
    const res = await request({ urlPath: '/api/browse_dir', body: {} });
    expect(res.status).toBe(401);
  });

  it('refuses a wrong token', async () => {
    const res = await request({
      urlPath: '/api/read_file',
      headers: { 'X-Fude-Token': 'b'.repeat(64) },
      body: { path: secretFile },
    });
    expect(res.status).toBe(401);
  });

  it('refuses the AI stream endpoint without a token', async () => {
    const res = await request({ urlPath: '/api/ai_chat_stream', body: { messages: [] } });
    expect(res.status).toBe(401);
  });

  it('refuses an unknown command without a token (no probing the surface)', async () => {
    const res = await request({ urlPath: '/api/does_not_exist', body: {} });
    expect(res.status).toBe(401);
  });
});

describe('authenticated API access still works', () => {
  it('reads a file with a valid token', async () => {
    const res = await request({
      urlPath: '/api/read_file',
      headers: auth(),
      body: { path: secretFile },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toBe('TOP SECRET');
  });

  it('writes a file with a valid token', async () => {
    const target = path.join(tmpDir, 'written.txt');
    const res = await request({
      urlPath: '/api/write_file',
      headers: auth(),
      body: { path: target, content: 'hello' },
    });
    expect(res.status).toBe(200);
    expect(fs.readFileSync(target, 'utf-8')).toBe('hello');
  });

  it('accepts the token via ?token= too', async () => {
    const res = await request({
      urlPath: `/api/read_file?token=${TOKEN}`,
      body: { path: secretFile },
    });
    expect(res.status).toBe(200);
  });

  it('reports an unknown command once authenticated', async () => {
    const res = await request({ urlPath: '/api/does_not_exist', headers: auth(), body: {} });
    expect(res.status).toBe(404);
  });

  // Tauri and the HTTP fallback disagree on the casing of this argument, and
  // reading only one of the two silently disabled "show all files" in browser
  // mode while leaving the desktop app working.
  it('read_dir_tree honours showAllFiles in either casing', async () => {
    const listing = path.join(tmpDir, 'listing');
    fs.mkdirSync(listing, { recursive: true });
    fs.writeFileSync(path.join(listing, 'note.md'), '#');
    fs.writeFileSync(path.join(listing, 'data.csv'), 'a,b');

    const names = (body) =>
      JSON.parse(body)
        .map((e) => e.name)
        .sort();

    const camel = await request({
      urlPath: '/api/read_dir_tree',
      headers: auth(),
      body: { path: listing, showAllFiles: true },
    });
    expect(names(camel.body)).toEqual(['data.csv', 'note.md']);

    const snake = await request({
      urlPath: '/api/read_dir_tree',
      headers: auth(),
      body: { path: listing, show_all_files: true },
    });
    expect(names(snake.body)).toEqual(['data.csv', 'note.md']);

    const off = await request({
      urlPath: '/api/read_dir_tree',
      headers: auth(),
      body: { path: listing },
    });
    expect(names(off.body)).toEqual(['note.md']);
  });

  it('does not expose inherited Object properties as commands', async () => {
    const res = await request({ urlPath: '/api/constructor', headers: auth(), body: {} });
    expect(res.status).toBe(404);
  });
});

describe('cross-site and DNS-rebinding defences', () => {
  it('no longer advertises Access-Control-Allow-Origin: *', async () => {
    const res = await request({ method: 'GET', urlPath: '/' });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rejects a request from another origin even with a valid token', async () => {
    const res = await request({
      urlPath: '/api/read_file',
      headers: { ...auth(), Origin: 'https://evil.example' },
      body: { path: secretFile },
    });
    expect(res.status).toBe(403);
  });

  it('rejects a rebound Host header', async () => {
    const res = await request({
      urlPath: '/api/read_file',
      rawPath: true,
      headers: { ...auth(), Host: `evil.example:${port}` },
      body: { path: secretFile },
    });
    expect(res.status).toBe(403);
  });

  it('accepts a same-origin Origin header', async () => {
    const res = await request({
      urlPath: '/api/read_file',
      headers: { ...auth(), Origin: `http://127.0.0.1:${port}` },
      body: { path: secretFile },
    });
    expect(res.status).toBe(200);
  });

  it('rejects GET on the API (no <img>/<script> side effects)', async () => {
    const res = await request({ method: 'GET', urlPath: `/api/read_file?token=${TOKEN}` });
    expect(res.status).toBe(405);
  });
});

describe('static file serving', () => {
  it('serves the app', async () => {
    const res = await request({ method: 'GET', urlPath: '/' });
    expect(res.status).toBe(200);
    expect(res.body).toContain('fude');
  });

  it('does not serve files outside dist via ../', async () => {
    const res = await request({
      method: 'GET',
      urlPath: '/../../../../../../../../etc/hostname',
    });
    expect(res.status).not.toBe(200);
    expect(res.body).not.toContain('root:');
  });

  it('does not serve the secret next to dist', async () => {
    const res = await request({ method: 'GET', urlPath: '/../secret.txt' });
    expect(res.body).not.toContain('TOP SECRET');
  });

  it('does not serve encoded traversal', async () => {
    const res = await request({ method: 'GET', urlPath: '/..%2f..%2fsecret.txt' });
    expect(res.status).not.toBe(200);
    expect(res.body).not.toContain('TOP SECRET');
  });

  it('sets nosniff', async () => {
    const res = await request({ method: 'GET', urlPath: '/' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('FUDE_ROOT confinement', () => {
  let confined;
  let confinedPort;

  beforeAll(async () => {
    const allowed = path.join(tmpDir, 'notes');
    fs.mkdirSync(allowed, { recursive: true });
    fs.writeFileSync(path.join(allowed, 'ok.md'), '# ok');

    confined = createFudeServer({ token: TOKEN, distDir, root: allowed });
    await new Promise((resolve) => confined.listen(0, '127.0.0.1', resolve));
    confinedPort = confined.address().port;
  });

  afterAll(async () => {
    if (confined) await new Promise((resolve) => confined.close(resolve));
  });

  function confinedRequest(urlPath, body) {
    return request({ urlPath, headers: auth(), body, to: confinedPort });
  }

  it('allows a path inside the root', async () => {
    const res = await confinedRequest('/api/read_file', {
      path: path.join(tmpDir, 'notes', 'ok.md'),
    });
    expect(res.status).toBe(200);
  });

  it('rejects a path outside the root', async () => {
    const res = await confinedRequest('/api/read_file', { path: secretFile });
    expect(res.status).toBe(403);
    expect(res.body).not.toContain('TOP SECRET');
  });

  it('rejects traversal out of the root', async () => {
    const res = await confinedRequest('/api/read_file', {
      path: path.join(tmpDir, 'notes', '..', 'secret.txt'),
    });
    expect(res.status).toBe(403);
  });

  it('rejects a write outside the root', async () => {
    const target = path.join(tmpDir, 'escaped.txt');
    const res = await confinedRequest('/api/write_file', { path: target, content: 'x' });
    expect(res.status).toBe(403);
    expect(fs.existsSync(target)).toBe(false);
  });
});
