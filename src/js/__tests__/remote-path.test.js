import { describe, it, expect } from 'vitest';
import {
  isRemotePath,
  splitRemotePath,
  remoteHost,
  displayRemotePath,
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
