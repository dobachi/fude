import { describe, it, expect, beforeEach } from 'vitest';
import {
  escapeHtml,
  resolveLanguage,
  highlightCode,
  _clearCacheForTest,
} from '../core/code-highlight.js';

beforeEach(() => {
  _clearCacheForTest();
});

describe('escapeHtml', () => {
  it('escapes HTML-significant characters', () => {
    expect(escapeHtml(`a < b && c > d "x" 'y'`)).toBe(
      'a &lt; b &amp;&amp; c &gt; d &quot;x&quot; &#39;y&#39;',
    );
  });
  it('leaves plain text untouched', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });
});

describe('resolveLanguage', () => {
  it('matches common language names and aliases', () => {
    expect(resolveLanguage('js')?.name).toBe('JavaScript');
    expect(resolveLanguage('javascript')?.name).toBe('JavaScript');
    expect(resolveLanguage('python')?.name).toBe('Python');
  });
  it('returns null for unknown or empty languages', () => {
    expect(resolveLanguage('totally-not-a-language')).toBeNull();
    expect(resolveLanguage('')).toBeNull();
    expect(resolveLanguage(null)).toBeNull();
  });
});

describe('highlightCode', () => {
  it('wraps recognizable tokens in tok-* spans', async () => {
    const html = await highlightCode('const x = 1;', 'js');
    expect(html).not.toBeNull();
    expect(html).toContain('class="tok-keyword"');
    expect(html).toContain('const');
    expect(html).toContain('class="tok-number"');
  });

  it('returns null for unknown languages so callers keep plain text', async () => {
    expect(await highlightCode('whatever', 'no-such-lang')).toBeNull();
    expect(await highlightCode('whatever', '')).toBeNull();
  });

  it('produces HTML-safe output (no raw angle brackets from source)', async () => {
    const html = await highlightCode('const ok = a < b && c > d;', 'js');
    expect(html).not.toBeNull();
    // Every literal < / > from the source must be escaped; only span tags
    // introduce real markup, and those are always <span ...> / </span>.
    const stripped = html.replace(/<\/?span[^>]*>/g, '');
    expect(stripped).not.toMatch(/[<>](?!span)/);
    expect(stripped).toContain('&lt;');
    expect(stripped).toContain('&gt;');
    expect(stripped).toContain('&amp;&amp;');
  });

  it('reconstructs the original source text exactly (no dropped chars)', async () => {
    const src = 'function add(a, b) {\n  return a + b; // sum\n}\n';
    const html = await highlightCode(src, 'js');
    expect(html).not.toBeNull();
    // Drop span tags, then unescape: must equal the original source.
    const text = html
      .replace(/<\/?span[^>]*>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
    expect(text).toBe(src);
  });
});
