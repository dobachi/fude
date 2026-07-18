import { describe, it, expect } from 'vitest';
import { resolveLinkTarget, normalizePath } from '../core/link-target.js';

describe('normalizePath', () => {
  it('collapses "." and ".." segments', () => {
    expect(normalizePath('/a/b/../c/./d.md')).toBe('/a/c/d.md');
  });

  it('keeps the POSIX root and refuses to climb above it', () => {
    expect(normalizePath('/a/../../b.md')).toBe('/b.md');
  });

  it('keeps a Windows drive root and converts separators', () => {
    expect(normalizePath('C:\\docs\\sub\\..\\note.md')).toBe('C:/docs/note.md');
  });

  it('collapses duplicate separators', () => {
    expect(normalizePath('/a//b///c.md')).toBe('/a/b/c.md');
  });

  it('keeps leading ".." on a relative path (nothing to pop)', () => {
    expect(normalizePath('../a/b.md')).toBe('../a/b.md');
  });
});

describe('resolveLinkTarget', () => {
  const base = '/home/u/docs';

  it('resolves a sibling file', () => {
    expect(resolveLinkTarget('other.md', base)).toEqual({
      path: '/home/u/docs/other.md',
      hash: '',
    });
  });

  it('resolves an explicit "./" prefix', () => {
    expect(resolveLinkTarget('./other.md', base)).toEqual({
      path: '/home/u/docs/other.md',
      hash: '',
    });
  });

  it('resolves a parent-directory link', () => {
    expect(resolveLinkTarget('../README.md', base)).toEqual({
      path: '/home/u/README.md',
      hash: '',
    });
  });

  it('resolves a nested path', () => {
    expect(resolveLinkTarget('sub/deep/note.md', base)).toEqual({
      path: '/home/u/docs/sub/deep/note.md',
      hash: '',
    });
  });

  it('takes an absolute path as-is, ignoring the base', () => {
    expect(resolveLinkTarget('/etc/notes/a.md', base)).toEqual({
      path: '/etc/notes/a.md',
      hash: '',
    });
  });

  it('takes a Windows absolute path as-is', () => {
    expect(resolveLinkTarget('C:\\notes\\a.md', base)).toEqual({ path: 'C:/notes/a.md', hash: '' });
  });

  it('splits off a fragment', () => {
    expect(resolveLinkTarget('other.md#section-1', base)).toEqual({
      path: '/home/u/docs/other.md',
      hash: 'section-1',
    });
  });

  it('decodes percent-encoded spaces in the path and the fragment', () => {
    expect(resolveLinkTarget('my%20notes/a%20b.md#%E8%A6%8B%E5%87%BA%E3%81%97', base)).toEqual({
      path: '/home/u/docs/my notes/a b.md',
      hash: '見出し',
    });
  });

  it('leaves malformed percent escapes untouched', () => {
    expect(resolveLinkTarget('100%.md', base)).toEqual({ path: '/home/u/docs/100%.md', hash: '' });
  });

  it('strips a file:// prefix', () => {
    expect(resolveLinkTarget('file:///tmp/a.md', base)).toEqual({ path: '/tmp/a.md', hash: '' });
  });

  it('trims surrounding whitespace', () => {
    expect(resolveLinkTarget('  other.md  ', base)).toEqual({
      path: '/home/u/docs/other.md',
      hash: '',
    });
  });

  it('tolerates a trailing separator on the base path', () => {
    expect(resolveLinkTarget('other.md', '/home/u/docs/')).toEqual({
      path: '/home/u/docs/other.md',
      hash: '',
    });
  });

  it.each([
    'https://example.com/a.md',
    'http://example.com',
    'mailto:a@example.com',
    'data:text/plain,hi',
    'javascript:alert(1)',
    'asset://localhost/a.png',
    'blob:abc',
  ])('rejects %s', (href) => {
    expect(resolveLinkTarget(href, base)).toBeNull();
  });

  it('rejects an in-page anchor', () => {
    expect(resolveLinkTarget('#section', base)).toBeNull();
  });

  it('rejects a relative link when there is no base path', () => {
    expect(resolveLinkTarget('other.md', '')).toBeNull();
  });

  it('still resolves an absolute link when there is no base path', () => {
    expect(resolveLinkTarget('/abs/a.md', '')).toEqual({ path: '/abs/a.md', hash: '' });
  });

  it.each([null, undefined, 42, '', '   '])('rejects the non-href %s', (href) => {
    expect(resolveLinkTarget(href, base)).toBeNull();
  });
});
