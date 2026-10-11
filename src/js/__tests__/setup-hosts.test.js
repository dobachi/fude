import { describe, it, expect } from 'vitest';
import { hostError, addHost, removeHost, outdatedCliMessage } from '../core/setup-hosts.js';

describe('hostError', () => {
  it('accepts ssh destinations', () => {
    for (const h of ['k16', 'me@box.example.net', ' k16 ', 'k16.tail-net.ts.net.', 'fe80::1']) {
      expect(hostError(h)).toBeNull();
    }
  });

  it('asks for a name when empty', () => {
    expect(hostError('')).toMatch(/入力/);
    expect(hostError('   ')).toMatch(/入力/);
    expect(hostError(null)).toMatch(/入力/);
    expect(hostError(undefined)).toMatch(/入力/);
  });

  it('refuses options and shell syntax', () => {
    for (const h of [
      '-oProxyCommand=x',
      '--port',
      'a b',
      'a;b',
      '$(x)',
      'a`b`',
      'a|b',
      "a'b",
      'a/b',
      'ホスト',
    ]) {
      expect(hostError(h), h).toMatch(/使えません/);
    }
    expect(hostError('a'.repeat(256))).toMatch(/使えません/);
  });
});

describe('addHost / removeHost', () => {
  it('appends once, trimmed, without touching the input', () => {
    const list = ['a'];
    expect(addHost(list, ' b ')).toEqual(['a', 'b']);
    expect(addHost(list, 'a')).toEqual(['a']);
    expect(addHost(list, '')).toEqual(['a']);
    expect(list).toEqual(['a']);
  });

  it('tolerates a missing or damaged list', () => {
    expect(addHost(undefined, 'a')).toEqual(['a']);
    expect(addHost(null, '')).toEqual([]);
    expect(addHost(['a', 3, '', null, ' '], 'b')).toEqual(['a', 'b']);
    expect(removeHost(undefined, 'a')).toEqual([]);
  });

  it('removes only the named host', () => {
    expect(removeHost(['a', 'b', 'ab'], 'a')).toEqual(['b', 'ab']);
    expect(removeHost(['a'], 'x')).toEqual(['a']);
  });
});

describe('outdatedCliMessage', () => {
  it('names the host, both versions and where to update', () => {
    const m = outdatedCliMessage('k16', '0.8.5', '0.8.6');
    expect(m).toContain('k16');
    expect(m).toContain('0.8.5');
    expect(m).toContain('0.8.6');
    expect(m).toContain('リモート接続');
  });
});
