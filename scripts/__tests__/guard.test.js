// @vitest-environment node
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import guard from '../lib/guard.js';

const {
  authorizeApi,
  extractToken,
  generateToken,
  isHostAllowed,
  isLoopbackHost,
  isOriginAllowed,
  isPathAllowed,
  resolveStaticPath,
  safeEqual,
} = guard;

const TOKEN = 'a'.repeat(64);

function req(overrides = {}) {
  return {
    url: '/api/read_file',
    headers: { host: '127.0.0.1:3000', 'x-fude-token': TOKEN },
    ...overrides,
  };
}

describe('safeEqual', () => {
  it('accepts identical strings', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
  });

  it('rejects different strings of the same length', () => {
    expect(safeEqual('abc', 'abd')).toBe(false);
  });

  it('rejects different lengths without throwing', () => {
    expect(safeEqual('abc', 'abcdef')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(safeEqual(undefined, 'abc')).toBe(false);
    expect(safeEqual(null, null)).toBe(false);
    expect(safeEqual(123, 123)).toBe(false);
  });
});

describe('generateToken', () => {
  it('produces a 64-char hex string', () => {
    expect(generateToken()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not repeat', () => {
    expect(generateToken()).not.toBe(generateToken());
  });
});

describe('extractToken', () => {
  it('reads the X-Fude-Token header', () => {
    expect(extractToken(req())).toBe(TOKEN);
  });

  it('reads an Authorization: Bearer header', () => {
    expect(extractToken({ url: '/api/x', headers: { authorization: `Bearer ${TOKEN}` } })).toBe(
      TOKEN,
    );
  });

  it('reads ?token= from the URL', () => {
    expect(extractToken({ url: `/api/x?token=${TOKEN}`, headers: {} })).toBe(TOKEN);
  });

  it('prefers the header over the query string', () => {
    expect(extractToken({ url: '/api/x?token=fromquery', headers: { 'x-fude-token': TOKEN } })).toBe(
      TOKEN,
    );
  });

  it('returns null when there is no token', () => {
    expect(extractToken({ url: '/api/x', headers: {} })).toBeNull();
  });

  it('returns null for a malformed URL instead of throwing', () => {
    expect(extractToken({ url: '://///', headers: {} })).toBeNull();
  });
});

describe('isHostAllowed', () => {
  it('allows loopback and localhost', () => {
    expect(isHostAllowed('localhost:3000')).toBe(true);
    expect(isHostAllowed('127.0.0.1:3000')).toBe(true);
    expect(isHostAllowed('[::1]:3000')).toBe(true);
  });

  it('allows IP literals, which cannot be DNS-rebound', () => {
    expect(isHostAllowed('192.168.1.5:3000')).toBe(true);
    expect(isHostAllowed('100.64.0.3:3000')).toBe(true);
  });

  it('rejects an attacker-controlled name (DNS rebinding)', () => {
    expect(isHostAllowed('evil.example:3000')).toBe(false);
    expect(isHostAllowed('fude.attacker.com')).toBe(false);
  });

  it('allows a name only when explicitly opted in', () => {
    expect(isHostAllowed('fude.tailnet.ts.net', ['fude.tailnet.ts.net'])).toBe(true);
    expect(isHostAllowed('FUDE.TAILNET.TS.NET', ['fude.tailnet.ts.net'])).toBe(true);
    expect(isHostAllowed('other.tailnet.ts.net', ['fude.tailnet.ts.net'])).toBe(false);
  });

  it('rejects a missing or unparseable Host header', () => {
    expect(isHostAllowed(undefined)).toBe(false);
    expect(isHostAllowed('')).toBe(false);
    expect(isHostAllowed('ho st:80')).toBe(false);
  });
});

describe('isOriginAllowed', () => {
  it('allows a same-origin request', () => {
    expect(isOriginAllowed('http://localhost:3000', 'localhost:3000')).toBe(true);
  });

  it('allows a request with no Origin (curl, native client)', () => {
    expect(isOriginAllowed(undefined, 'localhost:3000')).toBe(true);
    expect(isOriginAllowed('null', 'localhost:3000')).toBe(true);
  });

  it('rejects a cross-site Origin', () => {
    expect(isOriginAllowed('https://evil.example', 'localhost:3000')).toBe(false);
  });

  it('rejects a same-host Origin on a different port', () => {
    expect(isOriginAllowed('http://localhost:4000', 'localhost:3000')).toBe(false);
  });

  it('rejects an unparseable Origin', () => {
    expect(isOriginAllowed('not a url', 'localhost:3000')).toBe(false);
  });
});

describe('authorizeApi', () => {
  it('allows a well-formed authenticated request', () => {
    expect(authorizeApi(req(), { token: TOKEN })).toEqual({ ok: true });
  });

  it('rejects a request with no token', () => {
    const r = authorizeApi(req({ headers: { host: '127.0.0.1:3000' } }), { token: TOKEN });
    expect(r).toMatchObject({ ok: false, status: 401 });
  });

  it('rejects a wrong token', () => {
    const r = authorizeApi(req({ headers: { host: '127.0.0.1:3000', 'x-fude-token': 'b'.repeat(64) } }), {
      token: TOKEN,
    });
    expect(r).toMatchObject({ ok: false, status: 401 });
  });

  it('rejects a rebound host before checking the token', () => {
    const r = authorizeApi(
      req({ headers: { host: 'evil.example', 'x-fude-token': TOKEN } }),
      { token: TOKEN },
    );
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it('rejects a cross-origin request even with a valid token', () => {
    const r = authorizeApi(
      req({ headers: { host: '127.0.0.1:3000', origin: 'https://evil.example', 'x-fude-token': TOKEN } }),
      { token: TOKEN },
    );
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it('fails closed when the server has no token configured', () => {
    expect(authorizeApi(req(), { token: '' })).toMatchObject({ ok: false, status: 500 });
    expect(authorizeApi(req(), {})).toMatchObject({ ok: false, status: 500 });
  });
});

// The local token lives on disk and outlives any session; the remote key is
// supplied per launch. Letting the first one work from the network would turn
// a single leak of a long-lived secret into a standing remote grant.
describe('authorizeApi credential separation', () => {
  const REMOTE = 'r'.repeat(64);

  const asRemote = (provided) =>
    authorizeApi(
      req({ headers: { host: '192.168.1.10:3000', 'x-fude-token': provided } }),
      { token: TOKEN, remoteKey: REMOTE, isLoopback: false },
    );

  const asLocal = (provided) =>
    authorizeApi(
      req({ headers: { host: '127.0.0.1:3000', 'x-fude-token': provided } }),
      { token: TOKEN, remoteKey: REMOTE, isLoopback: true },
    );

  it('accepts the remote key from a remote client', () => {
    expect(asRemote(REMOTE)).toEqual({ ok: true });
  });

  it('refuses the local token from a remote client', () => {
    expect(asRemote(TOKEN)).toMatchObject({ ok: false, status: 401 });
  });

  it('accepts either credential over loopback', () => {
    expect(asLocal(TOKEN)).toEqual({ ok: true });
    expect(asLocal(REMOTE)).toEqual({ ok: true });
  });

  it('refuses an unrelated value from either side', () => {
    expect(asRemote('z'.repeat(64))).toMatchObject({ ok: false, status: 401 });
    expect(asLocal('z'.repeat(64))).toMatchObject({ ok: false, status: 401 });
  });

  it('refuses a remote client when no remote key is configured', () => {
    const r = authorizeApi(
      req({ headers: { host: '192.168.1.10:3000', 'x-fude-token': TOKEN } }),
      { token: TOKEN, isLoopback: false },
    );
    expect(r).toMatchObject({ ok: false, status: 401 });
  });

  it('still enforces host and origin for remote clients', () => {
    const rebound = authorizeApi(
      req({ headers: { host: 'evil.example', 'x-fude-token': REMOTE } }),
      { token: TOKEN, remoteKey: REMOTE, isLoopback: false },
    );
    expect(rebound).toMatchObject({ ok: false, status: 403 });

    const crossSite = authorizeApi(
      req({
        headers: {
          host: '192.168.1.10:3000',
          origin: 'https://evil.example',
          'x-fude-token': REMOTE,
        },
      }),
      { token: TOKEN, remoteKey: REMOTE, isLoopback: false },
    );
    expect(crossSite).toMatchObject({ ok: false, status: 403 });
  });
});

describe('resolveStaticPath', () => {
  const dist = path.resolve('/srv/fude/dist');

  it('maps / to index.html', () => {
    expect(resolveStaticPath(dist, '/')).toBe(path.join(dist, 'index.html'));
  });

  it('maps a normal asset', () => {
    expect(resolveStaticPath(dist, '/bundle.js')).toBe(path.join(dist, 'bundle.js'));
  });

  it('ignores the query string', () => {
    expect(resolveStaticPath(dist, '/bundle.js?v=2')).toBe(path.join(dist, 'bundle.js'));
  });

  it('allows a nested asset', () => {
    expect(resolveStaticPath(dist, '/assets/icon.png')).toBe(path.join(dist, 'assets', 'icon.png'));
  });

  it('rejects a NUL byte', () => {
    expect(resolveStaticPath(dist, '/index.html%00.png')).toBeNull();
  });

  it('rejects a malformed URL', () => {
    expect(resolveStaticPath(dist, '/%zz')).toBeNull();
  });

  // The real invariant: whatever the request says, the answer is either a path
  // under dist or nothing at all. `/../../../../etc/hostname` used to serve the
  // host's file; the URL parser now clamps such segments at the root, and the
  // prefix check catches what survives encoding (e.g. `..%2f`).
  it.each([
    '/../../../../etc/passwd',
    '/../../../../../../../../etc/hostname',
    '/%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/passwd',
    '/..%2f..%2f..%2f..%2fetc/passwd',
    '/./../../etc/passwd',
    '/../dist-secret/key',
    '//etc/passwd',
    '/assets/../../../../root/.ssh/id_rsa',
  ])('never escapes dist for %s', (url) => {
    const resolved = resolveStaticPath(dist, url);
    if (resolved !== null) {
      expect(resolved.startsWith(dist + path.sep)).toBe(true);
    }
  });

  it('returns null (not an escape) for encoded traversal that survives parsing', () => {
    expect(resolveStaticPath(dist, '/..%2f..%2f..%2f..%2fetc/passwd')).toBeNull();
  });
});

describe('isPathAllowed', () => {
  it('allows everything when no root is configured', () => {
    expect(isPathAllowed('/etc/passwd', '')).toBe(true);
    expect(isPathAllowed('/etc/passwd', undefined)).toBe(true);
  });

  it('allows paths inside the root', () => {
    expect(isPathAllowed('/home/u/notes/a.md', '/home/u/notes')).toBe(true);
    expect(isPathAllowed('/home/u/notes', '/home/u/notes')).toBe(true);
  });

  it('rejects paths outside the root', () => {
    expect(isPathAllowed('/etc/passwd', '/home/u/notes')).toBe(false);
    expect(isPathAllowed('/home/u/notes/../../.ssh/id_rsa', '/home/u/notes')).toBe(false);
  });

  it('rejects a sibling directory sharing the root prefix', () => {
    expect(isPathAllowed('/home/u/notes-secret/a.md', '/home/u/notes')).toBe(false);
  });

  it('rejects a missing path', () => {
    expect(isPathAllowed('', '/home/u/notes')).toBe(false);
    expect(isPathAllowed(undefined, '/home/u/notes')).toBe(false);
  });
});

describe('isLoopbackHost', () => {
  it('recognises loopback addresses', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.1.2.3')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
  });

  it('rejects addresses reachable from the network', () => {
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('192.168.1.5')).toBe(false);
    expect(isLoopbackHost('::')).toBe(false);
    expect(isLoopbackHost('')).toBe(false);
  });
});
