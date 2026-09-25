// @vitest-environment node
import { describe, it, expect } from 'vitest';
import netaccess from '../lib/netaccess.js';

const {
  createAttemptLimiter,
  ipInCidr,
  isLoopbackIp,
  isRemoteAllowed,
  normalizeIp,
  parseAllowSpec,
  parseCidr,
} = netaccess;

const cidrs = (spec) => parseAllowSpec(spec).cidrs;

describe('normalizeIp', () => {
  it('passes plain addresses through', () => {
    expect(normalizeIp('192.168.1.5')).toBe('192.168.1.5');
    expect(normalizeIp('fd7a:115c:a1e0::3')).toBe('fd7a:115c:a1e0::3');
  });

  // Without this, an IPv4 --allow rule silently fails to match any client that
  // arrived over a dual-stack listener, which looks like random rejections.
  it('unwraps IPv4-mapped IPv6', () => {
    expect(normalizeIp('::ffff:192.168.1.5')).toBe('192.168.1.5');
    expect(normalizeIp('::FFFF:10.0.0.1')).toBe('10.0.0.1');
  });

  it('strips brackets and zone ids', () => {
    expect(normalizeIp('[::1]')).toBe('::1');
    expect(normalizeIp('fe80::1%eth0')).toBe('fe80::1');
  });

  it('rejects things that are not addresses', () => {
    expect(normalizeIp('evil.example')).toBeNull();
    expect(normalizeIp('')).toBeNull();
    expect(normalizeIp(undefined)).toBeNull();
    expect(normalizeIp('999.1.1.1')).toBeNull();
  });
});

describe('parseCidr', () => {
  it('parses IPv4 and IPv6 ranges', () => {
    expect(parseCidr('192.168.1.0/24')).toMatchObject({ version: 4, bits: 24 });
    expect(parseCidr('fd7a:115c:a1e0::/48')).toMatchObject({ version: 6, bits: 48 });
  });

  it('treats a bare address as a single host', () => {
    expect(parseCidr('10.0.0.5')).toMatchObject({ version: 4, bits: 32 });
    expect(parseCidr('::1')).toMatchObject({ version: 6, bits: 128 });
  });

  it('masks off host bits', () => {
    expect(parseCidr('192.168.1.55/24').base).toBe(parseCidr('192.168.1.0/24').base);
  });

  it('rejects nonsense', () => {
    expect(parseCidr('192.168.1.0/33')).toBeNull();
    expect(parseCidr('::1/129')).toBeNull();
    expect(parseCidr('evil.example/24')).toBeNull();
    expect(parseCidr('')).toBeNull();
    expect(parseCidr('192.168.1.0/abc')).toBeNull();
  });
});

describe('ipInCidr', () => {
  it('matches inside the range and not outside', () => {
    const c = parseCidr('192.168.1.0/24');
    expect(ipInCidr('192.168.1.1', c)).toBe(true);
    expect(ipInCidr('192.168.1.255', c)).toBe(true);
    expect(ipInCidr('192.168.2.1', c)).toBe(false);
    expect(ipInCidr('192.167.1.1', c)).toBe(false);
  });

  it('matches an IPv4-mapped client against an IPv4 range', () => {
    expect(ipInCidr('::ffff:192.168.1.5', parseCidr('192.168.1.0/24'))).toBe(true);
  });

  it('does not match across address families', () => {
    expect(ipInCidr('::1', parseCidr('0.0.0.0/0'))).toBe(false);
    expect(ipInCidr('127.0.0.1', parseCidr('::/0'))).toBe(false);
  });

  it('handles /32 and /128 exactly', () => {
    expect(ipInCidr('10.0.0.5', parseCidr('10.0.0.5/32'))).toBe(true);
    expect(ipInCidr('10.0.0.6', parseCidr('10.0.0.5/32'))).toBe(false);
    expect(ipInCidr('::1', parseCidr('::1/128'))).toBe(true);
    expect(ipInCidr('::2', parseCidr('::1/128'))).toBe(false);
  });

  it('handles IPv6 ranges', () => {
    const c = parseCidr('fd7a:115c:a1e0::/48');
    expect(ipInCidr('fd7a:115c:a1e0::3', c)).toBe(true);
    expect(ipInCidr('fd7a:115c:a1e1::3', c)).toBe(false);
  });
});

describe('parseAllowSpec', () => {
  it('expands the lan preset', () => {
    const list = cidrs('lan');
    expect(isRemoteAllowed('192.168.1.5', list)).toBe(true);
    expect(isRemoteAllowed('10.1.2.3', list)).toBe(true);
    expect(isRemoteAllowed('172.16.0.1', list)).toBe(true);
    expect(isRemoteAllowed('8.8.8.8', list)).toBe(false);
  });

  it('expands the tailscale preset', () => {
    const list = cidrs('tailscale');
    expect(isRemoteAllowed('100.64.0.3', list)).toBe(true);
    expect(isRemoteAllowed('fd7a:115c:a1e0::3', list)).toBe(true);
    expect(isRemoteAllowed('192.168.1.5', list)).toBe(false);
  });

  it('accepts a comma-separated mix', () => {
    const list = cidrs('192.168.1.0/24, tailscale');
    expect(isRemoteAllowed('192.168.1.9', list)).toBe(true);
    expect(isRemoteAllowed('100.64.0.3', list)).toBe(true);
    expect(isRemoteAllowed('10.0.0.1', list)).toBe(false);
  });

  it('reports invalid entries instead of dropping them', () => {
    expect(parseAllowSpec('192.168.1.0/24,garbage').invalid).toEqual(['garbage']);
    expect(parseAllowSpec('192.168.1.0/99').invalid).toEqual(['192.168.1.0/99']);
  });

  it('de-duplicates', () => {
    expect(cidrs('192.168.1.0/24,192.168.1.0/24')).toHaveLength(1);
  });

  it('returns nothing for an empty spec', () => {
    expect(cidrs('')).toEqual([]);
    expect(isRemoteAllowed('192.168.1.5', [])).toBe(false);
  });
});

describe('isLoopbackIp', () => {
  it('recognises loopback', () => {
    expect(isLoopbackIp('127.0.0.1')).toBe(true);
    expect(isLoopbackIp('127.1.2.3')).toBe(true);
    expect(isLoopbackIp('::1')).toBe(true);
    expect(isLoopbackIp('::ffff:127.0.0.1')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isLoopbackIp('192.168.1.5')).toBe(false);
    expect(isLoopbackIp('100.64.0.3')).toBe(false);
    expect(isLoopbackIp('')).toBe(false);
  });
});

describe('createAttemptLimiter', () => {
  function limiterAt(t = { now: 0 }) {
    return {
      clock: t,
      limiter: createAttemptLimiter({ maxFailures: 3, baseLockoutMs: 1000, now: () => t.now }),
    };
  }

  it('allows an address that has not failed', () => {
    const { limiter } = limiterAt();
    expect(limiter.check('1.2.3.4').locked).toBe(false);
  });

  it('locks out after the configured number of failures', () => {
    const { limiter } = limiterAt();
    expect(limiter.recordFailure('1.2.3.4').locked).toBe(false);
    expect(limiter.recordFailure('1.2.3.4').locked).toBe(false);
    expect(limiter.recordFailure('1.2.3.4').locked).toBe(true);
    expect(limiter.check('1.2.3.4').locked).toBe(true);
  });

  it('reports how long to wait', () => {
    const { limiter } = limiterAt();
    limiter.recordFailure('1.2.3.4');
    limiter.recordFailure('1.2.3.4');
    const r = limiter.recordFailure('1.2.3.4');
    expect(r.retryAfterMs).toBe(1000);
  });

  it('releases the lock once the time has passed', () => {
    const clock = { now: 0 };
    const { limiter } = limiterAt(clock);
    for (let i = 0; i < 3; i++) limiter.recordFailure('1.2.3.4');
    expect(limiter.check('1.2.3.4').locked).toBe(true);
    clock.now = 1001;
    expect(limiter.check('1.2.3.4').locked).toBe(false);
  });

  it('backs off further on repeat offences', () => {
    const clock = { now: 0 };
    const { limiter } = limiterAt(clock);
    for (let i = 0; i < 3; i++) limiter.recordFailure('1.2.3.4');
    clock.now = 1001;
    for (let i = 0; i < 2; i++) limiter.recordFailure('1.2.3.4');
    const r = limiter.recordFailure('1.2.3.4');
    expect(r.retryAfterMs).toBe(2000);
  });

  it('tracks addresses independently', () => {
    const { limiter } = limiterAt();
    for (let i = 0; i < 3; i++) limiter.recordFailure('1.2.3.4');
    expect(limiter.check('1.2.3.4').locked).toBe(true);
    expect(limiter.check('5.6.7.8').locked).toBe(false);
  });

  it('a success clears the failure streak', () => {
    const { limiter } = limiterAt();
    limiter.recordFailure('1.2.3.4');
    limiter.recordFailure('1.2.3.4');
    limiter.recordSuccess('1.2.3.4');
    expect(limiter.recordFailure('1.2.3.4').locked).toBe(false);
    expect(limiter.recordFailure('1.2.3.4').locked).toBe(false);
    expect(limiter.recordFailure('1.2.3.4').locked).toBe(true);
  });

  it('caps the lockout', () => {
    const clock = { now: 0 };
    const limiter = createAttemptLimiter({
      maxFailures: 1,
      baseLockoutMs: 1000,
      maxLockoutMs: 4000,
      now: () => clock.now,
    });
    const seen = [];
    for (let i = 0; i < 6; i++) {
      seen.push(limiter.recordFailure('1.2.3.4').retryAfterMs);
      clock.now += 100000;
    }
    expect(Math.max(...seen)).toBe(4000);
  });
});
