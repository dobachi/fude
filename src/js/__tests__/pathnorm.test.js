import { describe, it, expect } from 'vitest';
import { stripPathDecorations, expandTilde, normalizeInputPath } from '../core/pathnorm.js';

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
