import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderMarkdown, initPreview, scrollToAnchor } from '../core/preview.js';
import { openExternal } from '../core/external-link.js';

vi.mock('../core/external-link.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, openExternal: vi.fn() };
});

let container;
let onFileLink;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  onFileLink = vi.fn();
  initPreview(container, { onFileLink });
  openExternal.mockClear();
  // jsdom does not implement scrollIntoView.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  container.remove();
});

function clickLink(selector = 'a') {
  const a = container.querySelector(selector);
  expect(a).toBeTruthy();
  const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
  a.dispatchEvent(ev);
  return ev;
}

describe('preview file links', () => {
  it('hands a relative link to onFileLink, resolved against the document dir', () => {
    renderMarkdown('[other](other.md)', '/home/u/docs', container);
    const ev = clickLink();
    expect(ev.defaultPrevented).toBe(true);
    expect(onFileLink).toHaveBeenCalledWith({ path: '/home/u/docs/other.md', hash: '' }, container);
  });

  it('passes the fragment along for links into a section of another file', () => {
    renderMarkdown('[x](../notes/a.md#intro)', '/home/u/docs', container);
    clickLink();
    expect(onFileLink).toHaveBeenCalledWith(
      { path: '/home/u/notes/a.md', hash: 'intro' },
      container,
    );
  });

  it('resolves against the container it was rendered into, not a sibling pane', () => {
    const other = document.createElement('div');
    document.body.appendChild(other);
    const otherOnFileLink = vi.fn();
    initPreview(other, { onFileLink: otherOnFileLink });

    renderMarkdown('[a](a.md)', '/vault/one', container);
    renderMarkdown('[b](b.md)', '/vault/two', other);

    clickLink();
    expect(onFileLink).toHaveBeenCalledWith({ path: '/vault/one/a.md', hash: '' }, container);
    other.remove();
  });

  it('sends external links to the OS browser, not to onFileLink', () => {
    renderMarkdown('[ext](https://example.com/a.md)', '/home/u/docs', container);
    clickLink();
    expect(openExternal).toHaveBeenCalledWith('https://example.com/a.md');
    expect(onFileLink).not.toHaveBeenCalled();
  });

  it('keeps in-page anchors internal', () => {
    renderMarkdown('# Intro\n\n[jump](#intro)', '/home/u/docs', container);
    const ev = clickLink('a[href="#intro"]');
    expect(ev.defaultPrevented).toBe(true);
    expect(onFileLink).not.toHaveBeenCalled();
  });

  it('never navigates the webview: an unresolvable link is swallowed', () => {
    // No base path, so the relative link cannot be resolved to a file. The
    // click must still be prevented or the Tauri webview navigates away.
    renderMarkdown('[nope](other.md)', '', container);
    const ev = clickLink();
    expect(ev.defaultPrevented).toBe(true);
    expect(onFileLink).not.toHaveBeenCalled();
  });

  it('does nothing when no onFileLink handler is wired', () => {
    const bare = document.createElement('div');
    document.body.appendChild(bare);
    initPreview(bare, {});
    renderMarkdown('[a](a.md)', '/vault', bare);
    const a = bare.querySelector('a');
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    expect(() => a.dispatchEvent(ev)).not.toThrow();
    bare.remove();
  });
});

describe('scrollToAnchor', () => {
  it('scrolls to a matching heading id', () => {
    renderMarkdown('# Hello World\n\ntext', '', container);
    const heading = container.querySelector('h1');
    heading.scrollIntoView = vi.fn();
    expect(scrollToAnchor(container, heading.id)).toBe(true);
    expect(heading.scrollIntoView).toHaveBeenCalled();
  });

  it('returns false when nothing matches', () => {
    renderMarkdown('# Hello', '', container);
    expect(scrollToAnchor(container, 'no-such-anchor')).toBe(false);
  });

  it('returns false for a missing container or empty id', () => {
    expect(scrollToAnchor(null, 'x')).toBe(false);
    expect(scrollToAnchor(container, '')).toBe(false);
  });
});
