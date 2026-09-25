// @vitest-environment node
//
// Remote mode over a real socket. These bind to a real non-loopback address so
// that `req.socket.remoteAddress` is genuinely remote — the whole point is what
// happens to connections that are NOT loopback, and a test that only ever talks
// to 127.0.0.1 exercises the opposite branch.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOCAL_TOKEN = 'a'.repeat(64);
const REMOTE_KEY = 'b'.repeat(64);

/** A real address of this machine, so the server sees a non-loopback peer. */
function findLanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return null;
}

const LAN_IP = findLanIp();
const describeRemote = LAN_IP ? describe : describe.skip;

describeRemote('remote mode', () => {
  let createFudeServer;
  let netaccess;
  let tmpDir;
  let distDir;
  let notesDir;
  let outsideFile;
  let server;
  let port;

  function request({ urlPath = '/api/read_file', headers = {}, body, to = port, host = LAN_IP }) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request(
        {
          host,
          port: to,
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
      if (payload) req.write(payload);
      req.end();
    });
  }

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fude-remote-'));
    distDir = path.join(tmpDir, 'dist');
    notesDir = path.join(tmpDir, 'notes');
    fs.mkdirSync(distDir);
    fs.mkdirSync(notesDir);
    fs.writeFileSync(path.join(distDir, 'index.html'), '<html>fude</html>');
    fs.writeFileSync(path.join(notesDir, 'ok.md'), '# inside');
    outsideFile = path.join(tmpDir, 'secret.txt');
    fs.writeFileSync(outsideFile, 'TOP SECRET');

    process.env.FUDE_TOKEN = LOCAL_TOKEN;
    ({ createFudeServer } = await import('../serve.js'));
    netaccess = (await import('../lib/netaccess.js')).default;

    server = createFudeServer({
      token: LOCAL_TOKEN,
      remoteKey: REMOTE_KEY,
      allowCidrs: netaccess.parseAllowSpec(`${LAN_IP}/32`).cidrs,
      distDir,
      root: notesDir,
    });
    await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
    port = server.address().port;
  });

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    delete process.env.FUDE_TOKEN;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const withKey = (k) => ({ 'X-Fude-Token': k });
  const inside = () => ({ path: path.join(notesDir, 'ok.md') });

  describe('credential separation', () => {
    it('accepts the remote key from an allowed address', async () => {
      const res = await request({ headers: withKey(REMOTE_KEY), body: inside() });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toBe('# inside');
    });

    // The local token is persisted on disk and long-lived. If it also opened
    // the door from the network, one leak would be a permanent remote grant.
    it('refuses the persisted local token from a remote address', async () => {
      const res = await request({ headers: withKey(LOCAL_TOKEN), body: inside() });
      expect(res.status).toBe(401);
      expect(res.body).not.toContain('inside');
    });

    it('still accepts the local token over loopback', async () => {
      const res = await request({ headers: withKey(LOCAL_TOKEN), body: inside(), host: '127.0.0.1' });
      expect(res.status).toBe(200);
    });

    it('refuses no key at all', async () => {
      const res = await request({ body: inside() });
      expect(res.status).toBe(401);
    });
  });

  describe('root confinement', () => {
    it('serves a file inside --root', async () => {
      const res = await request({ headers: withKey(REMOTE_KEY), body: inside() });
      expect(res.status).toBe(200);
    });

    it('refuses a file outside --root even with a valid key', async () => {
      const res = await request({ headers: withKey(REMOTE_KEY), body: { path: outsideFile } });
      expect(res.status).toBe(403);
      expect(res.body).not.toContain('TOP SECRET');
    });

    it('refuses a write outside --root', async () => {
      const target = path.join(tmpDir, 'escaped.txt');
      const res = await request({
        urlPath: '/api/write_file',
        headers: withKey(REMOTE_KEY),
        body: { path: target, content: 'x' },
      });
      expect(res.status).toBe(403);
      expect(fs.existsSync(target)).toBe(false);
    });
  });

  describe('range gate', () => {
    let closed;
    let closedPort;

    beforeAll(async () => {
      // Allow only TEST-NET-3, which this machine is definitely not on.
      closed = createFudeServer({
        token: LOCAL_TOKEN,
        remoteKey: REMOTE_KEY,
        allowCidrs: netaccess.parseAllowSpec('203.0.113.0/24').cidrs,
        distDir,
        root: notesDir,
      });
      await new Promise((resolve) => closed.listen(0, '0.0.0.0', resolve));
      closedPort = closed.address().port;
    });

    afterAll(async () => {
      if (closed) await new Promise((resolve) => closed.close(resolve));
    });

    it('drops a connection from outside the range before any HTTP', async () => {
      // A destroyed socket surfaces as a transport error, not an HTTP status:
      // the port does not answer at all to an address outside --allow.
      await expect(
        request({ headers: withKey(REMOTE_KEY), body: inside(), to: closedPort }),
      ).rejects.toThrow();
    });

    it('does not even serve static files outside the range', async () => {
      const attempt = new Promise((resolve, reject) => {
        const req = http.request(
          { host: LAN_IP, port: closedPort, method: 'GET', path: '/' },
          (res) => {
            let d = '';
            res.on('data', (c) => (d += c));
            res.on('end', () => resolve(d));
          },
        );
        req.on('error', reject);
        req.end();
      });
      await expect(attempt).rejects.toThrow();
    });

    it('still accepts loopback, which is never gated by --allow', async () => {
      const res = await request({
        headers: withKey(LOCAL_TOKEN),
        body: inside(),
        to: closedPort,
        host: '127.0.0.1',
      });
      expect(res.status).toBe(200);
    });
  });

  describe('brute-force lockout', () => {
    let limited;
    let limitedPort;

    beforeAll(async () => {
      limited = createFudeServer({
        token: LOCAL_TOKEN,
        remoteKey: REMOTE_KEY,
        allowCidrs: netaccess.parseAllowSpec(`${LAN_IP}/32`).cidrs,
        distDir,
        root: notesDir,
        limiter: netaccess.createAttemptLimiter({ maxFailures: 3, baseLockoutMs: 60000 }),
      });
      await new Promise((resolve) => limited.listen(0, '0.0.0.0', resolve));
      limitedPort = limited.address().port;
    });

    afterAll(async () => {
      if (limited) await new Promise((resolve) => limited.close(resolve));
    });

    it('locks the address out after repeated wrong keys', async () => {
      const statuses = [];
      for (let i = 0; i < 5; i++) {
        const res = await request({
          headers: withKey(`wrong${i}`.padEnd(64, 'z')),
          body: inside(),
          to: limitedPort,
        });
        statuses.push(res.status);
      }
      expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
      expect(statuses.slice(3)).toEqual([429, 429]);
    });

    it('refuses even the correct key while locked out', async () => {
      const res = await request({
        headers: withKey(REMOTE_KEY),
        body: inside(),
        to: limitedPort,
      });
      expect(res.status).toBe(429);
      expect(res.headers['retry-after']).toBeDefined();
    });

    it('does not lock out loopback along with it', async () => {
      const res = await request({
        headers: withKey(LOCAL_TOKEN),
        body: inside(),
        to: limitedPort,
        host: '127.0.0.1',
      });
      expect(res.status).toBe(200);
    });
  });
});

describe('remote mode (environment check)', () => {
  it('has a non-loopback address to test against', () => {
    // Not an assertion about the code: it records whether the suite above ran.
    if (!LAN_IP) console.warn('No non-loopback IPv4 found; remote socket tests were skipped.');
    expect(true).toBe(true);
  });
});
