// @vitest-environment node
//
// The refusal rules are the feature: exposing this API to a network without
// stating who may reach it, or without confining what they may touch, should be
// impossible to do by accident.
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import cli from '../lib/cli.js';

const { parseArgs, MIN_KEY_LENGTH } = cli;

const ok = (argv, env = {}) => {
  const r = parseArgs(argv, env);
  if (!r.ok) throw new Error(`expected success, got: ${r.error}`);
  return r.config;
};
const err = (argv, env = {}) => {
  const r = parseArgs(argv, env);
  expect(r.ok).toBe(false);
  return r.error;
};

describe('defaults', () => {
  it('is local and unremarkable with no arguments', () => {
    const c = ok([]);
    expect(c.host).toBe('127.0.0.1');
    expect(c.port).toBe(3000);
    expect(c.remote).toBe(false);
    expect(c.tls.enabled).toBe(false);
    expect(c.keySource.type).toBe('auto');
    expect(c.allowCidrs).toEqual([]);
  });

  it('reads the environment', () => {
    const c = ok([], { FUDE_PORT: '4567', FUDE_OPEN_DIR: '/tmp/notes' });
    expect(c.port).toBe(4567);
    expect(c.openDir).toBe('/tmp/notes');
  });

  it('command line beats environment', () => {
    expect(ok(['--port', '5000'], { FUDE_PORT: '4000' }).port).toBe(5000);
  });

  it('accepts --opt=value', () => {
    expect(ok(['--port=4321']).port).toBe(4321);
  });

  it('accepts short flags', () => {
    const c = ok(['-p', '4444']);
    expect(c.port).toBe(4444);
  });

  it('rejects a bad port', () => {
    expect(err(['--port', 'abc'])).toMatch(/Invalid port/);
    expect(err(['--port', '99999'])).toMatch(/Invalid port/);
  });

  it('rejects unknown options and stray arguments', () => {
    expect(err(['--nope'])).toMatch(/Unknown option/);
    expect(err(['somefile.md'])).toMatch(/Unexpected argument/);
    expect(err(['--port'])).toMatch(/needs a value/);
  });

  it('--help short-circuits', () => {
    const r = parseArgs(['--help']);
    expect(r.help).toBe(true);
  });
});

describe('remote requires an explicit range', () => {
  it('refuses a non-loopback bind with no --allow', () => {
    expect(err(['--listen', '0.0.0.0', '--root', '/tmp'])).toMatch(/--allow is required/);
    expect(err(['--listen', '192.168.1.10', '--root', '/tmp'])).toMatch(/--allow is required/);
    expect(err(['--listen', '::', '--root', '/tmp'])).toMatch(/--allow is required/);
  });

  it('does not demand --allow for loopback', () => {
    expect(ok(['--listen', '127.0.0.1']).remote).toBe(false);
    expect(ok(['--listen', 'localhost']).remote).toBe(false);
    expect(ok(['--listen', '::1']).remote).toBe(false);
  });

  it('refuses an unparseable range rather than narrowing it', () => {
    expect(err(['--listen', '0.0.0.0', '--allow', 'garbage', '--root', '/tmp'])).toMatch(
      /Invalid --allow/,
    );
  });

  it('accepts CIDRs and presets', () => {
    const c = ok(['--listen', '0.0.0.0', '--allow', '192.168.1.0/24,tailscale', '--root', '/tmp']);
    expect(c.remote).toBe(true);
    expect(c.allowCidrs.length).toBeGreaterThan(1);
  });
});

describe('remote requires a confined root', () => {
  it('refuses a non-loopback bind with no --root', () => {
    const msg = err(['--listen', '0.0.0.0', '--allow', 'lan']);
    expect(msg).toMatch(/--root is required/);
    expect(msg).toMatch(/i-know-what-im-doing/);
  });

  it('allows opting out deliberately', () => {
    const c = ok(['--listen', '0.0.0.0', '--allow', 'lan', '--i-know-what-im-doing']);
    expect(c.root).toBe('');
    expect(c.rootOverride).toBe(true);
  });

  // Compare against path.resolve, not a literal: on Windows '/tmp/notes'
  // resolves to 'D:\\tmp\\notes', which is correct behaviour, not a bug.
  it('resolves --root to an absolute path', () => {
    const c = ok(['--listen', '0.0.0.0', '--allow', 'lan', '--root', '/tmp/notes']);
    expect(c.root).toBe(path.resolve('/tmp/notes'));
    expect(path.isAbsolute(c.root)).toBe(true);
  });

  it('resolves a relative --root against the working directory', () => {
    const c = ok(['--listen', '0.0.0.0', '--allow', 'lan', '--root', 'notes']);
    expect(c.root).toBe(path.resolve('notes'));
    expect(path.isAbsolute(c.root)).toBe(true);
  });

  it('accepts FUDE_ROOT in place of --root', () => {
    const c = ok(['--listen', '0.0.0.0', '--allow', 'lan'], { FUDE_ROOT: '/tmp/notes' });
    expect(c.root).toBe(path.resolve('/tmp/notes'));
  });
});

describe('key', () => {
  const remote = ['--listen', '0.0.0.0', '--allow', 'lan', '--root', '/tmp'];

  it('generates one when none is given', () => {
    expect(ok(remote).keySource).toEqual({ type: 'auto' });
  });

  it('takes a literal key', () => {
    const c = ok([...remote, '--key', 'x'.repeat(24)]);
    expect(c.keySource).toEqual({ type: 'literal', value: 'x'.repeat(24) });
  });

  it('refuses a guessable key', () => {
    const msg = err([...remote, '--key', 'hunter2']);
    expect(msg).toMatch(new RegExp(`at least ${MIN_KEY_LENGTH}`));
    expect(msg).toMatch(/openssl rand/);
  });

  it('takes a key file', () => {
    expect(ok([...remote, '--key-file', '/tmp/k']).keySource).toEqual({
      type: 'file',
      path: '/tmp/k',
    });
  });

  it('takes stdin', () => {
    expect(ok([...remote, '--key', '-']).keySource).toEqual({ type: 'stdin' });
  });

  it('refuses --key together with --key-file', () => {
    expect(err([...remote, '--key', 'x'.repeat(20), '--key-file', '/tmp/k'])).toMatch(/not both/);
  });

  it('takes FUDE_KEY and still enforces the length', () => {
    expect(ok(remote, { FUDE_KEY: 'y'.repeat(20) }).keySource.type).toBe('env');
    expect(err(remote, { FUDE_KEY: 'short' })).toMatch(/at least/);
  });
});

describe('tls', () => {
  const remote = ['--listen', '0.0.0.0', '--allow', 'lan', '--root', '/tmp'];

  it('is on by default when remote — the key crosses the network', () => {
    expect(ok(remote).tls.enabled).toBe(true);
  });

  it('is off by default when local — a cert would only add a warning', () => {
    expect(ok([]).tls.enabled).toBe(false);
  });

  it('can be forced off for a tunnelled setup', () => {
    expect(ok([...remote, '--no-tls']).tls.enabled).toBe(false);
  });

  it('can be forced on locally', () => {
    expect(ok(['--tls']).tls.enabled).toBe(true);
  });

  it('accepts a supplied certificate', () => {
    const c = ok([...remote, '--tls-cert', '/tmp/c.pem', '--tls-key', '/tmp/k.pem']);
    expect(c.tls).toMatchObject({ enabled: true, certPath: '/tmp/c.pem', keyPath: '/tmp/k.pem' });
  });

  it('refuses half a certificate', () => {
    expect(err([...remote, '--tls-cert', '/tmp/c.pem'])).toMatch(/must be given together/);
    expect(err([...remote, '--tls-key', '/tmp/k.pem'])).toMatch(/must be given together/);
  });

  it('refuses contradictory flags', () => {
    expect(err([...remote, '--tls', '--no-tls'])).toMatch(/not both/);
  });
});
