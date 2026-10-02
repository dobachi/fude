// @vitest-environment node
//
// Browser mode used to have no extension commands at all, so PlantUML/Mermaid
// could neither be installed nor rendered there. These drive the real server
// over a socket, with the network replaced by a fake fetch.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const TOKEN = 'e'.repeat(64);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

let server;
let port;
let tmpDir;
let serve;
let savedRuntime;

function request({ urlPath, body, headers = { 'X-Fude-Token': TOKEN } }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body ?? {});
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: urlPath,
        headers: { 'Content-Type': 'application/json', ...headers },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/** The `data:` events of a server-sent event stream. */
function events(body) {
  return body
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)));
}

const ENGINE = 'console.log("engine")';
const MANIFEST = JSON.stringify({
  schema: 1,
  extensions: [
    {
      id: 'mermaid',
      name: 'Mermaid',
      version: '11.0.0',
      files: [
        {
          rel: 'mermaid.min.js',
          url: 'https://x.test/mermaid.min.js',
          sha256: sha(ENGINE),
          size: ENGINE.length,
        },
      ],
    },
    {
      id: 'broken',
      name: 'Broken',
      version: '1.0.0',
      files: [{ rel: 'b.js', url: 'https://x.test/b.js', sha256: sha('other'), size: 3 }],
    },
  ],
});

async function fakeFetch(url) {
  const map = {
    'https://raw.githubusercontent.com/dobachi/fude-extensions/main/manifest.json': MANIFEST,
    'https://x.test/mermaid.min.js': ENGINE,
    'https://x.test/b.js': 'bad',
  };
  if (!(url in map)) return { ok: false, status: 404, text: async () => '', body: [] };
  return { ok: true, status: 200, text: async () => map[url], body: [Buffer.from(map[url])] };
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fude-srv-ext-'));
  const distDir = path.join(tmpDir, 'dist');
  fs.mkdirSync(distDir);
  fs.writeFileSync(path.join(distDir, 'index.html'), '<html>fude</html>');

  process.env.FUDE_TOKEN = TOKEN;
  serve = await import('../serve.js');
  savedRuntime = { ...serve.runtime };
  serve.runtime.extensionsDir = path.join(tmpDir, 'extensions');
  serve.runtime.fetch = fakeFetch;
  // --root must not get in the way: extensions live outside the user's notes.
  server = serve.createFudeServer({ token: TOKEN, distDir, root: path.join(tmpDir, 'notes') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  Object.assign(serve.runtime, savedRuntime);
  delete process.env.FUDE_TOKEN;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('extension commands in browser mode', () => {
  it('requires the session token', async () => {
    for (const urlPath of ['/api/install_extension', '/api/read_extension_file']) {
      const res = await request({ urlPath, body: { id: 'mermaid' }, headers: {} });
      expect(res.status).toBe(401);
    }
  });

  it('serves the catalogue (an async handler)', async () => {
    const res = await request({ urlPath: '/api/fetch_extension_manifest' });
    expect(res.status).toBe(200);
    expect(JSON.parse(JSON.parse(res.body)).extensions[0].id).toBe('mermaid');
  });

  it('reports not installed, installs with streamed progress, then reads the file', async () => {
    let res = await request({ urlPath: '/api/extension_status', body: { id: 'mermaid' } });
    expect(JSON.parse(res.body).installed).toBe(false);

    res = await request({ urlPath: '/api/install_extension', body: { id: 'mermaid' } });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    const evs = events(res.body);
    expect(evs.some((e) => e.status === 'progress')).toBe(true);
    expect(evs.at(-1)).toEqual({ status: 'done', progress: ENGINE.length, total: ENGINE.length });

    res = await request({ urlPath: '/api/extension_status', body: { id: 'mermaid' } });
    expect(JSON.parse(res.body)).toMatchObject({ installed: true, version: '11.0.0' });

    res = await request({
      urlPath: '/api/read_extension_file',
      body: { id: 'mermaid', rel: 'mermaid.min.js' },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toBe(ENGINE);
  });

  it('streams an error event when verification fails', async () => {
    const res = await request({ urlPath: '/api/install_extension', body: { id: 'broken' } });
    const evs = events(res.body);
    expect(evs.at(-1).status).toBe('error');
    expect(evs.at(-1).error).toContain('Checksum mismatch');
  });

  it('refuses to read outside the extensions directory', async () => {
    fs.writeFileSync(path.join(tmpDir, 'secret.txt'), 'TOP SECRET');
    const res = await request({
      urlPath: '/api/read_extension_file',
      body: { id: 'mermaid', rel: '../../../secret.txt' },
    });
    expect(res.status).toBe(500);
    expect(res.body).not.toContain('TOP SECRET');
  });

  it('uninstalls', async () => {
    let res = await request({ urlPath: '/api/uninstall_extension', body: { id: 'mermaid' } });
    expect(res.status).toBe(200);
    res = await request({ urlPath: '/api/extension_status', body: { id: 'mermaid' } });
    expect(JSON.parse(res.body).installed).toBe(false);
  });
});
