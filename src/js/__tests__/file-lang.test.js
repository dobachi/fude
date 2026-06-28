import { describe, it, expect } from 'vitest';
import { extOf, isMarkdownPath, languageDescForPath, shouldOpenAsCode } from '../core/file-lang.js';

describe('extOf', () => {
  it('returns the lowercased extension', () => {
    expect(extOf('/a/b/foo.JS')).toBe('js');
    expect(extOf('foo.tar.gz')).toBe('gz');
    expect(extOf('C:\\path\\Main.RS')).toBe('rs');
  });
  it('returns empty for no extension or dotfiles', () => {
    expect(extOf('/a/b/Makefile')).toBe('');
    expect(extOf('.gitignore')).toBe('');
    expect(extOf('')).toBe('');
    expect(extOf(null)).toBe('');
  });
});

describe('isMarkdownPath', () => {
  it('recognizes Markdown family extensions', () => {
    for (const p of ['a.md', 'b.markdown', 'c.mdx', 'd.qmd', 'e.rmd', 'F.MD']) {
      expect(isMarkdownPath(p)).toBe(true);
    }
  });
  it('rejects source files and unknowns', () => {
    for (const p of ['a.js', 'b.py', 'c.rs', 'd.txt', 'Makefile', '']) {
      expect(isMarkdownPath(p)).toBe(false);
    }
  });
});

describe('languageDescForPath', () => {
  it('matches source files to a CodeMirror language', () => {
    expect(languageDescForPath('/x/app.js')?.name).toBe('JavaScript');
    expect(languageDescForPath('script.py')?.name).toBe('Python');
    expect(languageDescForPath('main.rs')?.name).toBe('Rust');
  });
  it('returns null for Markdown files (handled as Markdown)', () => {
    expect(languageDescForPath('readme.md')).toBeNull();
  });
  it('returns null for unknown extensions', () => {
    expect(languageDescForPath('notes.xyzlang')).toBeNull();
    expect(languageDescForPath('')).toBeNull();
  });
});

describe('shouldOpenAsCode', () => {
  it('is true only for non-Markdown files when the mode is on', () => {
    expect(shouldOpenAsCode('a.js', true)).toBe(true);
    expect(shouldOpenAsCode('a.txt', true)).toBe(true); // unknown lang, still code-mode (plain)
  });
  it('is false for Markdown files even when the mode is on', () => {
    expect(shouldOpenAsCode('a.md', true)).toBe(false);
    expect(shouldOpenAsCode('a.qmd', true)).toBe(false);
  });
  it('is false whenever the mode is off', () => {
    expect(shouldOpenAsCode('a.js', false)).toBe(false);
    expect(shouldOpenAsCode('a.md', false)).toBe(false);
  });
  it('is false without a path', () => {
    expect(shouldOpenAsCode('', true)).toBe(false);
    expect(shouldOpenAsCode(null, true)).toBe(false);
  });
});
