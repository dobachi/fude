import { describe, it, expect } from 'vitest';
import { parseRemoteSpec, formatRemoteSpec, prefillFromClipboard } from '../core/remote-spec.js';

// The same table as Tana's remotespec.test.js (both apps accept the same forms)
const OK = [
  // canonical (URL)
  ['ssh://k16/home/me/notes/a.md', 'k16', '/home/me/notes/a.md'],
  ['ssh://k16', 'k16', ''],
  ['ssh://k16/', 'k16', '/'],
  ['ssh://k16/~/work', 'k16', '~/work'],
  ['ssh://k16/~', 'k16', '~'],
  ['sftp://k16/srv', 'k16', '/srv'],
  ['remote://k16/srv', 'k16', '/srv'],
  ['SSH://k16/srv', 'k16', '/srv'],
  ['ssh://me@k16/srv', 'me@k16', '/srv'],
  ['ssh://me@k16:22/srv', 'me@k16', '/srv'],
  ['ssh://k16/home/a%20b.md', 'k16', '/home/a b.md'],
  ['ssh://k16/home/a b.md', 'k16', '/home/a b.md'],
  ['ssh://k16/home/a.md#L42', 'k16', '/home/a.md'],
  ['ssh://host.example.com/x', 'host.example.com', '/x'],
  // scp-like short form
  ['k16:/srv/data', 'k16', '/srv/data'],
  ['k16:~/notes', 'k16', '~/notes'],
  ['k16:~', 'k16', '~'],
  ['me@k16:/srv', 'me@k16', '/srv'],
  ['k16:/path with space/a.md', 'k16', '/path with space/a.md'],
  // decoration typical of AI output
  ['`ssh://k16/tmp`', 'k16', '/tmp'],
  ['"k16:/tmp"', 'k16', '/tmp'],
  ['<ssh://k16/tmp>', 'k16', '/tmp'],
  ['- ssh://k16/tmp', 'k16', '/tmp'],
  ['1. k16:/tmp', 'k16', '/tmp'],
  ['  ssh://k16/tmp  ', 'k16', '/tmp'],
  ['```\nssh://k16/tmp\n```', 'k16', '/tmp'],
  ['```text\n\nk16:/tmp\n```\n', 'k16', '/tmp'],
  ['「ssh://k16/tmp」', 'k16', '/tmp'],
];

const NOT_REMOTE = [
  '',
  '   ',
  '/home/me/a.md',
  '~/notes',
  'C:\\Users\\me',
  'C:/Users/me',
  'https://example.com/a',
  'localhost:8080',
  '12:30',
  'Note: 明日やる',
  'k16:relative/path',
  'ssh://',
  'ssh://-oProxyCommand=x/tmp',
  'ssh://k16 /tmp',
];

describe('parseRemoteSpec', () => {
  it.each(OK)('%s', (text, host, path) => {
    expect(parseRemoteSpec(text)).toEqual({ host, path });
  });

  it.each(NOT_REMOTE)('not a remote place: %j', (text) => {
    expect(parseRemoteSpec(text)).toBeNull();
  });

  it('null for a non-string', () => {
    expect(parseRemoteSpec(null)).toBeNull();
    expect(parseRemoteSpec(42)).toBeNull();
  });

  it('refuses a port other than 22, saying to use an ssh config Host', () => {
    const r = parseRemoteSpec('ssh://k16:2222/srv');
    expect(r.error).toContain('2222');
    expect(r.error).toContain('~/.ssh/config');
  });

  it('uses the first line that reads', () => {
    expect(parseRemoteSpec('次の場所です:\nk16:/a\nk16:/b')).toEqual({ host: 'k16', path: '/a' });
  });
});

describe('formatRemoteSpec', () => {
  it('writes the canonical form, which reads back the same', () => {
    for (const [host, path] of [
      ['k16', '/srv/a.md'],
      ['me@k16', '~/x'],
      ['k16', ''],
      ['k16', '/path with space/a.md'],
    ]) {
      const s = formatRemoteSpec(host, path);
      expect(s.startsWith('ssh://')).toBe(true);
      expect(parseRemoteSpec(s)).toEqual({ host, path });
    }
  });
});

describe('prefillFromClipboard', () => {
  it('gives the canonical form of a remote place', () => {
    expect(prefillFromClipboard('```\nk16:/srv/a b\n```')).toBe('ssh://k16/srv/a b');
    expect(prefillFromClipboard('`sftp://me@k16/~/x`')).toBe('ssh://me@k16/~/x');
  });
  it('null when not a place, refused, or unreadable', () => {
    expect(prefillFromClipboard('/home/me')).toBeNull();
    expect(prefillFromClipboard('ssh://k16:2222/x')).toBeNull();
    expect(prefillFromClipboard('')).toBeNull();
    expect(prefillFromClipboard(undefined)).toBeNull();
  });
});
