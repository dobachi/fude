import { describe, it, expect } from 'vitest';
import {
  hostError,
  addHost,
  removeHost,
  outdatedCliMessage,
  addRecent,
  recentPaths,
  forgetRecent,
  RECENT_MAX,
  recentHosts,
  openTargets,
  commonPrefix,
  pathSuggestions,
  SUGGEST_MAX,
} from '../core/setup-hosts.js';

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

describe('remembered places', () => {
  it('puts the newest first and keeps one of each', () => {
    let list = addRecent([], 'k16', '~/notes');
    list = addRecent(list, 'k16', '/srv/docs');
    list = addRecent(list, 'box', '~/notes');
    list = addRecent(list, 'k16', '~/notes');
    expect(list).toEqual(['k16\t~/notes', 'box\t~/notes', 'k16\t/srv/docs']);
    expect(recentPaths(list, 'k16')).toEqual(['~/notes', '/srv/docs']);
    expect(recentPaths(list, 'box')).toEqual(['~/notes']);
    expect(recentPaths(list, 'nobody')).toEqual([]);
  });

  it('remembers no path as the home directory, and trims', () => {
    expect(addRecent([], ' k16 ', '  ')).toEqual(['k16\t~']);
    expect(addRecent([], 'k16', ' ~/a b ')).toEqual(['k16\t~/a b']);
  });

  it('a host is not confused with one whose name it starts', () => {
    const list = addRecent(addRecent([], 'k16', '/a'), 'k16b', '/b');
    expect(recentPaths(list, 'k16')).toEqual(['/a']);
    expect(forgetRecent(list, 'k16')).toEqual(['k16b\t/b']);
  });

  it('ignores a missing host and junk in the stored list', () => {
    expect(addRecent(['k16\t/a'], '', '/x')).toEqual(['k16\t/a']);
    expect(addRecent(null, 'k16', '/a')).toEqual(['k16\t/a']);
    expect(recentPaths([null, 3, '', 'k16\t/a'], 'k16')).toEqual(['/a']);
  });

  it('keeps the list bounded, dropping the oldest', () => {
    let list = [];
    for (let i = 0; i < RECENT_MAX + 5; i++) list = addRecent(list, 'k16', `/p${i}`);
    expect(list.length).toBe(RECENT_MAX);
    expect(list[0]).toBe(`k16\t/p${RECENT_MAX + 4}`);
    expect(list).not.toContain('k16\t/p0');
  });

  it('the outdated notice points at the remote view', () => {
    expect(outdatedCliMessage('k16', '0.8.8', '0.8.9')).toMatch(/リモート接続/);
  });
});

describe('destinations and suggestions', () => {
  it('lists hosts used lately first, then set up, then from the ssh config', () => {
    const recent = ['box\t/a', 'wsl\t~/x', 'k16\t~/n', 'box\t/b'];
    expect(recentHosts(recent)).toEqual(['box', 'k16']);
    expect(openTargets(recent, ['k16', 'dev'], ['dev', 'git', 'box'])).toEqual([
      'box',
      'k16',
      'dev',
      'git',
    ]);
    expect(openTargets([], [], [])).toEqual([]);
    // A name ssh could not take is not offered.
    expect(openTargets([], ['ok', 'bad name', '-x'], null)).toEqual(['ok']);
  });

  it('finds how far candidates agree', () => {
    expect(commonPrefix(['~/Sources/', '~/Sandbox/', '~/Summary.md'])).toBe('~/S');
    expect(commonPrefix(['~/Sources/'])).toBe('~/Sources/');
    expect(commonPrefix(['abc', 'xyz'])).toBe('');
    expect(commonPrefix([])).toBe('');
    expect(commonPrefix(null)).toBe('');
  });

  it('offers matching earlier places before completions, each once', () => {
    const recent = ['~/Sources/fude', '/srv/docs', '~/Sources/'];
    expect(pathSuggestions('~/S', recent, ['~/Sandbox/', '~/Sources/'])).toEqual([
      '~/Sources/fude',
      '~/Sources/',
      '~/Sandbox/',
    ]);
    // Nothing typed: everything opened before, then what is in home.
    expect(pathSuggestions('', recent, ['notes/'])).toEqual([...recent, 'notes/']);
    // What is already typed is not a suggestion.
    expect(pathSuggestions('/srv/docs', recent, ['/srv/docs/a.md'])).toEqual(['/srv/docs/a.md']);
    expect(pathSuggestions('x', null, null)).toEqual([]);
  });

  it('keeps the list short', () => {
    const many = Array.from({ length: SUGGEST_MAX + 20 }, (_, i) => `/p${i}`);
    expect(pathSuggestions('', [], many).length).toBe(SUGGEST_MAX);
  });
});
