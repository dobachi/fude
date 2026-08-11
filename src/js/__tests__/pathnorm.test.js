import { describe, it, expect } from 'vitest';
import {
  stripPathDecorations,
  expandTilde,
  normalizeInputPath,
  fileDirForTree,
  isWithinDir,
  resolveRevealDir,
  canonicalPath,
  samePath,
} from '../core/pathnorm.js';

describe('stripPathDecorations', () => {
  it('trims surrounding whitespace', () => {
    expect(stripPathDecorations('  /home/u/a.md  ')).toBe('/home/u/a.md');
  });

  it('strips matching single/double quotes', () => {
    expect(stripPathDecorations('"/home/u/a b.md"')).toBe('/home/u/a b.md');
    expect(stripPathDecorations("'/home/u/a b.md'")).toBe('/home/u/a b.md');
  });

  it('does not strip mismatched or one-sided quotes', () => {
    expect(stripPathDecorations('"/home/u/a.md')).toBe('"/home/u/a.md');
    expect(stripPathDecorations('\'/home/u/a.md"')).toBe('\'/home/u/a.md"');
  });

  it('un-escapes shell-escaped spaces', () => {
    expect(stripPathDecorations('/home/u/a\\ b\\ c.md')).toBe('/home/u/a b c.md');
  });

  it('handles empty / nullish input', () => {
    expect(stripPathDecorations('')).toBe('');
    expect(stripPathDecorations('   ')).toBe('');
    expect(stripPathDecorations(null)).toBe('');
    expect(stripPathDecorations(undefined)).toBe('');
  });
});

describe('expandTilde', () => {
  const home = '/home/u';

  it('expands bare ~ to home', () => {
    expect(expandTilde('~', home)).toBe('/home/u');
  });

  it('expands ~/… to home/…', () => {
    expect(expandTilde('~/notes/a.md', home)).toBe('/home/u/notes/a.md');
  });

  it('leaves ~user and mid-path tildes untouched', () => {
    expect(expandTilde('~bob/a.md', home)).toBe('~bob/a.md');
    expect(expandTilde('/tmp/~x', home)).toBe('/tmp/~x');
  });

  it('is a no-op without a home', () => {
    expect(expandTilde('~/a.md', '')).toBe('~/a.md');
  });

  it('does not touch absolute paths', () => {
    expect(expandTilde('/mnt/c/Users/x/a.md', home)).toBe('/mnt/c/Users/x/a.md');
  });
});

describe('normalizeInputPath', () => {
  const home = '/home/u';

  it('combines stripping and tilde expansion', () => {
    expect(normalizeInputPath('  "~/a b.md"  ', home)).toBe('/home/u/a b.md');
    expect(normalizeInputPath('~/notes/\\ x.md', home)).toBe('/home/u/notes/ x.md');
  });

  it('returns empty string for blank input', () => {
    expect(normalizeInputPath('   ', home)).toBe('');
    expect(normalizeInputPath('', home)).toBe('');
  });

  it('passes absolute WSL paths through unchanged', () => {
    expect(normalizeInputPath('/mnt/c/Users/x/a.md', home)).toBe('/mnt/c/Users/x/a.md');
    expect(normalizeInputPath('/home/u/proj/README.md', home)).toBe('/home/u/proj/README.md');
  });
});

describe('fileDirForTree', () => {
  it('returns the parent directory of a POSIX path', () => {
    expect(fileDirForTree('/home/u/notes/a.md')).toBe('/home/u/notes');
    expect(fileDirForTree('/mnt/c/Users/x/a.md')).toBe('/mnt/c/Users/x');
  });

  it('keeps the root separator for root-level files', () => {
    expect(fileDirForTree('/a.md')).toBe('/');
  });

  it('handles Windows separators and drive roots', () => {
    expect(fileDirForTree('C:\\Users\\x\\a.md')).toBe('C:\\Users\\x');
    expect(fileDirForTree('C:\\a.md')).toBe('C:\\');
  });

  it('returns empty for paths without a parent', () => {
    expect(fileDirForTree('a.md')).toBe('');
    expect(fileDirForTree('')).toBe('');
    expect(fileDirForTree('   ')).toBe('');
    expect(fileDirForTree(null)).toBe('');
    expect(fileDirForTree(undefined)).toBe('');
  });

  it('trims surrounding whitespace before splitting', () => {
    expect(fileDirForTree('  /home/u/a.md  ')).toBe('/home/u');
  });
});

describe('isWithinDir', () => {
  it('treats a directory as within itself', () => {
    expect(isWithinDir('/home/u/notes', '/home/u/notes')).toBe(true);
  });

  it('ignores trailing separators', () => {
    expect(isWithinDir('/home/u/notes', '/home/u/notes/')).toBe(true);
    expect(isWithinDir('/home/u/notes//', '/home/u/notes')).toBe(true);
    expect(isWithinDir('C:\\x\\', 'C:\\x')).toBe(true);
  });

  it('accepts descendants at any depth', () => {
    expect(isWithinDir('/home/u/notes/sub', '/home/u/notes')).toBe(true);
    expect(isWithinDir('/home/u/notes/a/b/c', '/home/u/notes')).toBe(true);
    expect(isWithinDir('C:\\x\\y\\z', 'C:\\x')).toBe(true);
  });

  it('handles roots without doubling the separator', () => {
    expect(isWithinDir('/home/u', '/')).toBe(true);
    expect(isWithinDir('/', '/')).toBe(true);
    expect(isWithinDir('C:\\x', 'C:\\')).toBe(true);
  });

  it('rejects ancestors, siblings and name prefixes', () => {
    expect(isWithinDir('/home/u', '/home/u/notes')).toBe(false);
    expect(isWithinDir('/home/u/other', '/home/u/notes')).toBe(false);
    // '/home/u/notes2' must not count as inside '/home/u/notes'.
    expect(isWithinDir('/home/u/notes2', '/home/u/notes')).toBe(false);
  });

  it('rejects empty input on either side', () => {
    expect(isWithinDir('', '')).toBe(false);
    expect(isWithinDir('/home/u', '')).toBe(false);
    expect(isWithinDir('', '/home/u')).toBe(false);
    expect(isWithinDir(null, undefined)).toBe(false);
  });
});

describe('resolveRevealDir', () => {
  it('opens the file directory when it differs from the current tree root', () => {
    expect(resolveRevealDir('/home/u/notes/a.md', '/home/u/other')).toEqual({
      action: 'open',
      dir: '/home/u/notes',
    });
  });

  it('opens the file directory when no folder is loaded yet', () => {
    expect(resolveRevealDir('/home/u/notes/a.md', '')).toEqual({
      action: 'open',
      dir: '/home/u/notes',
    });
    expect(resolveRevealDir('/home/u/notes/a.md', null)).toEqual({
      action: 'open',
      dir: '/home/u/notes',
    });
  });

  it('reveals in place when the folder is already the tree root', () => {
    expect(resolveRevealDir('/home/u/notes/a.md', '/home/u/notes')).toEqual({
      action: 'reveal',
      dir: '/home/u/notes',
    });
    expect(resolveRevealDir('/home/u/notes/a.md', '/home/u/notes/')).toEqual({
      action: 'reveal',
      dir: '/home/u/notes',
    });
  });

  it('reveals in place for a file nested below the tree root', () => {
    // Re-rooting at the file's own folder would needlessly narrow the tree.
    expect(resolveRevealDir('/home/u/notes/sub/deep/a.md', '/home/u/notes')).toEqual({
      action: 'reveal',
      dir: '/home/u/notes/sub/deep',
    });
  });

  it('re-roots for a sibling folder that merely shares a name prefix', () => {
    expect(resolveRevealDir('/home/u/notes2/a.md', '/home/u/notes')).toEqual({
      action: 'open',
      dir: '/home/u/notes2',
    });
  });

  it('re-roots when the file sits above the tree root', () => {
    expect(resolveRevealDir('/home/u/a.md', '/home/u/notes')).toEqual({
      action: 'open',
      dir: '/home/u',
    });
  });

  it('does nothing for a tab with no saved path', () => {
    expect(resolveRevealDir(null, '/home/u/notes')).toEqual({ action: 'none', dir: '' });
    expect(resolveRevealDir('', '/home/u/notes')).toEqual({ action: 'none', dir: '' });
    expect(resolveRevealDir('untitled.md', '/home/u/notes')).toEqual({ action: 'none', dir: '' });
  });
});

// \\wsl$\<distro> と \\wsl.localhost\<distro> は同じ場所の別名。tana からは
// 後者、エクスプローラや古いセッションからは前者で届き、同じファイルが別物として
// 扱われていた（タブが二重に開く / vault 相対にならない / ツリーで見つからない）。
describe('canonicalPath / samePath', () => {
  const legacy = '\\\\wsl$\\Ubuntu-22.04\\home\\me\\notes\\a.md';
  const modern = '\\\\wsl.localhost\\Ubuntu-22.04\\home\\me\\notes\\a.md';

  it('WSL の旧 UNC 別名を新しい形に寄せる', () => {
    expect(canonicalPath(legacy)).toBe(modern);
    expect(canonicalPath(modern)).toBe(modern);
  });

  it('先頭以外の wsl$ には触らない', () => {
    expect(canonicalPath('/home/me/wsl$/a.md')).toBe('/home/me/wsl$/a.md');
  });

  it('WSL 以外のパスはそのまま', () => {
    expect(canonicalPath('/home/me/a.md')).toBe('/home/me/a.md');
    expect(canonicalPath('C:\\notes\\a.md')).toBe('C:\\notes\\a.md');
    expect(canonicalPath(null)).toBe('');
  });

  it('別名違いを同一視する', () => {
    expect(samePath(legacy, modern)).toBe(true);
    expect(samePath(modern, modern)).toBe(true);
  });

  it('別ファイルは同一視しない', () => {
    expect(samePath(legacy, modern.replace('a.md', 'b.md'))).toBe(false);
    expect(samePath('/home/me/a.md', '/home/me/A.md')).toBe(false); // 大小は区別する
  });

  it('空パスはどれとも一致しない（未選択の取り違えを防ぐ）', () => {
    expect(samePath('', '')).toBe(false);
    expect(samePath(null, undefined)).toBe(false);
    expect(samePath(null, '/home/me/a.md')).toBe(false);
  });

  it('isWithinDir も別名違いを吸収する', () => {
    expect(isWithinDir(legacy, '\\\\wsl.localhost\\Ubuntu-22.04\\home\\me\\notes')).toBe(true);
    expect(isWithinDir(modern, '\\\\wsl$\\Ubuntu-22.04\\home\\me')).toBe(true);
  });
});
