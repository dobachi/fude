import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderMarkdown, initPreview, sourceLineFromElement } from '../core/preview.js';

let container;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  container.remove();
});

function dblclick(el) {
  el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
}

describe('sourceLineFromElement', () => {
  it('reads the source line off the element itself', () => {
    const el = document.createElement('p');
    el.setAttribute('data-source-line', '4');
    expect(sourceLineFromElement(el)).toBe(4);
  });

  it('walks up to the nearest ancestor carrying the attribute', () => {
    const block = document.createElement('p');
    block.setAttribute('data-source-line', '7');
    const inline = document.createElement('strong');
    block.appendChild(inline);
    expect(sourceLineFromElement(inline)).toBe(7);
  });

  it('returns null when no ancestor has a source line', () => {
    const el = document.createElement('div');
    expect(sourceLineFromElement(el)).toBeNull();
  });

  it('returns null for a non-numeric attribute', () => {
    const el = document.createElement('p');
    el.setAttribute('data-source-line', 'x');
    expect(sourceLineFromElement(el)).toBeNull();
  });

  it('handles null input', () => {
    expect(sourceLineFromElement(null)).toBeNull();
  });
});

describe('initPreview double-click to source', () => {
  it('calls onSourceJump with the block line and container', () => {
    const onSourceJump = vi.fn();
    initPreview(container, { onSourceJump });
    renderMarkdown('# Title\n\npara text\n', '', container);

    const p = container.querySelector('p');
    dblclick(p);

    expect(onSourceJump).toHaveBeenCalledTimes(1);
    expect(onSourceJump).toHaveBeenCalledWith(3, container);
  });

  it('resolves the line from an inline descendant of a block', () => {
    const onSourceJump = vi.fn();
    initPreview(container, { onSourceJump });
    renderMarkdown('# Heading with **bold**\n', '', container);

    const strong = container.querySelector('strong');
    dblclick(strong);

    expect(onSourceJump).toHaveBeenCalledWith(1, container);
  });

  it('does nothing when the target has no source line', () => {
    const onSourceJump = vi.fn();
    initPreview(container, { onSourceJump });
    // Container itself carries no data-source-line.
    dblclick(container);
    expect(onSourceJump).not.toHaveBeenCalled();
  });

  it('is a no-op when no onSourceJump callback is provided', () => {
    initPreview(container);
    renderMarkdown('para\n', '', container);
    const p = container.querySelector('p');
    expect(() => dblclick(p)).not.toThrow();
  });
});
