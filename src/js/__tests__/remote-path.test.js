import { describe, it, expect } from 'vitest';
import {
  isRemotePath,
  splitRemotePath,
  remoteHost,
  displayRemotePath,
  resolveRemotePath,
  imageMime,
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
