// @vitest-environment node
//
// Browser mode stores workspaces the way the desktop app does: workspaces.json
// in the config dir. HOME points at a temp dir so the real config is untouched.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOKEN = 'w'.repeat(64);
let server;
let port;
let tmpDir;
let savedHome;

function call(cmd, body = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: `/api/${cmd}`,
        headers: { 'Content-Type': 'application/json', 'X-Fude-Token': TOKEN },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fude-srv-ws-'));
  savedHome = process.env.HOME;
  process.env.HOME = tmpDir;
  fs.mkdirSync(path.join(tmpDir, '.config', 'fude'), { recursive: true });
  const distDir = path.join(tmpDir, 'dist');
  fs.mkdirSync(distDir);
  fs.writeFileSync(path.join(distDir, 'index.html'), '<html>fude</html>');
  process.env.FUDE_TOKEN = TOKEN;
  const serve = await import('../serve.js');
  server = serve.createFudeServer({ token: TOKEN, distDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  process.env.HOME = savedHome;
  delete process.env.FUDE_TOKEN;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('workspace commands in browser mode', () => {
  it('has no workspaces until some are saved', async () => {
    const res = await call('load_workspaces');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toBeNull();
  });

  it('saves and loads them back, in the config dir', async () => {
    const store = {
      active: 'notes',
      workspaces: [
        { name: 'default', keep: {}, session: null },
        { name: 'notes', keep: { tabs: false }, session: { vault_path: '/n', open_tabs: [] } },
      ],
    };
    expect((await call('save_workspaces', { store })).status).toBe(200);
    expect(fs.existsSync(path.join(tmpDir, '.config', 'fude', 'workspaces.json'))).toBe(true);
    const back = JSON.parse((await call('load_workspaces')).body);
    expect(back).toEqual(store);
  });

  it('refuses a store without an active name', async () => {
    const res = await call('save_workspaces', { store: { workspaces: [] } });
    expect(res.status).not.toBe(200);
  });
});
