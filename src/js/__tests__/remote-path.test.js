import { describe, it, expect } from 'vitest';
import {
  isRemotePath,
  splitRemotePath,
  remoteHost,
  displayRemotePath,
  resolveRemotePath,
  imageMime,
  remoteParent,
  connectionFor,
  remoteReach,
  remoteSaveAsPath,
} from '../core/remote-path.js';

describe('remote-path', () => {
  it('recognises the remote scheme only', () => {
    expect(isRemotePath('remote://box/home/u/a.md')).toBe(true);
    expect(isRemotePath('/home/u/a.md')).toBe(false);
    expect(isRemotePath('C:\\notes\\a.md')).toBe(false);
    expect(isRemotePath(null)).toBe(false);
    expect(isRemotePath(undefined)).toBe(false);
  });

  it('splits host and absolute path', () => {
    expect(splitRemotePath('remote://box/home/u/a.md')).toEqual({
      host: 'box',
      path: '/home/u/a.md',
    });
    expect(splitRemotePath('remote://box/')).toEqual({ host: 'box', path: '/' });
  });

  it('rejects malformed remote paths', () => {
    expect(splitRemotePath('remote:///x')).toBeNull();
    expect(splitRemotePath('remote://box')).toBeNull();
    expect(splitRemotePath('/local')).toBeNull();
  });

  it('exposes the host and a readable form', () => {
    expect(remoteHost('remote://box/a.md')).toBe('box');
    expect(remoteHost('/a.md')).toBeNull();
    expect(displayRemotePath('remote://box/home/u/a.md')).toBe('box:/home/u/a.md');
    expect(displayRemotePath('/home/u/a.md')).toBe('/home/u/a.md');
  });
});

describe('resolveRemotePath', () => {
  const base = 'remote://k16/home/u/docs';

  it('joins a relative file onto the document directory', () => {
    expect(resolveRemotePath(base, 'a.png')).toBe('remote://k16/home/u/docs/a.png');
    expect(resolveRemotePath(base, 'img/a b.png')).toBe('remote://k16/home/u/docs/img/a b.png');
    expect(resolveRemotePath(base, './img/画像.png')).toBe('remote://k16/home/u/docs/img/画像.png');
    expect(resolveRemotePath(`${base}/`, 'a.png')).toBe('remote://k16/home/u/docs/a.png');
  });

  it('resolves .. itself, since the agent refuses paths that contain it', () => {
    expect(resolveRemotePath(base, '../assets/a.png')).toBe('remote://k16/home/u/assets/a.png');
    expect(resolveRemotePath(base, 'x/../y/./a.png')).toBe('remote://k16/home/u/docs/y/a.png');
    // Above the root stops at the root.
    expect(resolveRemotePath(base, '../../../../../a.png')).toBe('remote://k16/a.png');
  });

  it('takes a leading slash as the root of the same host', () => {
    expect(resolveRemotePath(base, '/var/img/a.png')).toBe('remote://k16/var/img/a.png');
    expect(resolveRemotePath(base, '/var/../etc/a.png')).toBe('remote://k16/etc/a.png');
  });

  it('accepts backslashes and a document at the root', () => {
    expect(resolveRemotePath(base, 'img\\a.png')).toBe('remote://k16/home/u/docs/img/a.png');
    expect(resolveRemotePath('remote://k16', 'a.png')).toBe('remote://k16/a.png');
    expect(resolveRemotePath('remote://k16/', 'a.png')).toBe('remote://k16/a.png');
  });

  it('is null for a local base', () => {
    expect(resolveRemotePath('/home/u/docs', 'a.png')).toBeNull();
    expect(resolveRemotePath('', 'a.png')).toBeNull();
    expect(resolveRemotePath(null, 'a.png')).toBeNull();
  });
});

describe('imageMime', () => {
  it('labels the formats an <img> shows, case-insensitively', () => {
    expect(imageMime('remote://k16/a/b.png')).toBe('image/png');
    expect(imageMime('x.JPG')).toBe('image/jpeg');
    expect(imageMime('x.jpeg')).toBe('image/jpeg');
    expect(imageMime('x.svg')).toBe('image/svg+xml');
    expect(imageMime('x.webp')).toBe('image/webp');
    expect(imageMime('x.gif')).toBe('image/gif');
  });

  it('falls back to the generic type', () => {
    expect(imageMime('x.xyz')).toBe('application/octet-stream');
    expect(imageMime('noext')).toBe('application/octet-stream');
    expect(imageMime('')).toBe('application/octet-stream');
    expect(imageMime(null)).toBe('application/octet-stream');
  });
});

describe('moving around on a remote machine', () => {
  it('finds the folder above, stopping at the root', () => {
    expect(remoteParent('remote://k16/home/u/notes')).toBe('remote://k16/home/u');
    expect(remoteParent('remote://k16/home/u/notes/')).toBe('remote://k16/home/u');
    expect(remoteParent('remote://k16/home')).toBe('remote://k16/');
    expect(remoteParent('remote://k16/')).toBeNull();
    expect(remoteParent('/home/u/notes')).toBeNull();
    expect(remoteParent('')).toBeNull();
    expect(remoteParent(null)).toBeNull();
  });

  const conns = [
    { id: 1, host: 'k16', roots: ['/home/u'], origin: null },
    { id: 2, host: 'k16', roots: ['/home/u/notes'], origin: 'ssh:me@k16' },
    { id: 3, host: 'home', roots: ['/home/d/Sources/'], origin: 'wsl' },
    { id: 4, host: 'box', roots: ['/'], origin: 'ssh:box' },
  ];

  it('picks the connection whose root is the closest above the path', () => {
    expect(connectionFor('remote://k16/home/u/notes/a.md', conns).id).toBe(2);
    expect(connectionFor('remote://k16/home/u/notes', conns).id).toBe(2);
    expect(connectionFor('remote://k16/home/u/other', conns).id).toBe(1);
    // Not fooled by a name that merely starts the same.
    expect(connectionFor('remote://k16/home/u/notes2/x', conns).id).toBe(1);
    expect(connectionFor('remote://home/home/d/Sources/x', conns).id).toBe(3);
    expect(connectionFor('remote://box/anything', conns).id).toBe(4);
    expect(connectionFor('remote://k16/srv', conns)).toBeNull();
    expect(connectionFor('remote://gone/x', conns)).toBeNull();
    expect(connectionFor('/local/x', conns)).toBeNull();
    expect(connectionFor('remote://k16/home/u', null)).toBeNull();
  });

  it('reaches the machine the way this window got there', () => {
    expect(remoteReach('remote://k16/home/u/notes/a.md', conns)).toEqual({
      kind: 'ssh',
      host: 'me@k16',
      known: true,
    });
    expect(remoteReach('remote://home/home/d/Sources/x', conns)).toEqual({
      kind: 'wsl',
      known: true,
    });
    // An agent that connected by itself: only its name is known.
    expect(remoteReach('remote://k16/home/u/other', conns)).toEqual({
      kind: 'ssh',
      host: 'k16',
      known: false,
    });
    expect(remoteReach('remote://gone/x', [])).toEqual({ kind: 'ssh', host: 'gone', known: false });
    expect(remoteReach('/local', conns)).toBeNull();
  });
});

describe('remoteSaveAsPath: リモートのタブを名前を付けて保存する先', () => {
  const DIR = 'remote://k16/home/u/notes';

  it('ファイル名だけなら、同じフォルダに保存する', () => {
    expect(remoteSaveAsPath(DIR, 'b.md')).toBe('remote://k16/home/u/notes/b.md');
    expect(remoteSaveAsPath(DIR, '  sub/c.md  ')).toBe('remote://k16/home/u/notes/sub/c.md');
    expect(remoteSaveAsPath(DIR, '../d.md')).toBe('remote://k16/home/u/d.md');
  });

  it('/ で始まればホストの絶対パス', () => {
    expect(remoteSaveAsPath(DIR, '/tmp/x.md')).toBe('remote://k16/tmp/x.md');
  });

  it('表示どおりの host:/path も、remote:// の形も受け付ける', () => {
    expect(remoteSaveAsPath(DIR, 'k16:/home/u/e.md')).toBe('remote://k16/home/u/e.md');
    expect(remoteSaveAsPath(DIR, 'remote://k16/srv/f.md')).toBe('remote://k16/srv/f.md');
  });

  it('別のホストや空の入力、フォルダで終わる入力は受け付けない', () => {
    expect(remoteSaveAsPath(DIR, 'box:/home/u/a.md')).toBeNull();
    expect(remoteSaveAsPath(DIR, 'remote://box/a.md')).toBeNull();
    expect(remoteSaveAsPath(DIR, '   ')).toBeNull();
    expect(remoteSaveAsPath(DIR, undefined)).toBeNull();
    expect(remoteSaveAsPath(DIR, 'sub/')).toBeNull();
    expect(remoteSaveAsPath(DIR, '/')).toBeNull();
  });

  it('基準がリモートでなければ null', () => {
    expect(remoteSaveAsPath('/home/u', 'a.md')).toBeNull();
  });
});
