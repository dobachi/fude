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

function ctrlClick(el, opts = { ctrlKey: true }) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...opts }));
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

describe('initPreview Ctrl+click to source', () => {
  it('calls onSourceJump with the block line and container', () => {
    const onSourceJump = vi.fn();
    initPreview(container, { onSourceJump });
    renderMarkdown('# Title\n\npara text\n', '', container);

    ctrlClick(container.querySelector('p'));

    expect(onSourceJump).toHaveBeenCalledTimes(1);
    expect(onSourceJump).toHaveBeenCalledWith(3, container);
  });

  it('accepts Cmd (meta) as well as Ctrl', () => {
    const onSourceJump = vi.fn();
    initPreview(container, { onSourceJump });
    renderMarkdown('para\n', '', container);
    ctrlClick(container.querySelector('p'), { metaKey: true });
    expect(onSourceJump).toHaveBeenCalledWith(1, container);
  });

  it('resolves the line from an inline descendant of a block', () => {
    const onSourceJump = vi.fn();
    initPreview(container, { onSourceJump });
    renderMarkdown('# Heading with **bold**\n', '', container);

    ctrlClick(container.querySelector('strong'));

    expect(onSourceJump).toHaveBeenCalledWith(1, container);
  });

  it('ignores a plain click', () => {
    const onSourceJump = vi.fn();
    initPreview(container, { onSourceJump });
    renderMarkdown('para\n', '', container);
    ctrlClick(container.querySelector('p'), {});
    expect(onSourceJump).not.toHaveBeenCalled();
  });

  it('does not jump when Ctrl+clicking a link', () => {
    const onSourceJump = vi.fn();
    initPreview(container, { onSourceJump });
    renderMarkdown('[a](#x)\n', '', container);
    ctrlClick(container.querySelector('a'));
    expect(onSourceJump).not.toHaveBeenCalled();
  });

  it('does nothing when the target has no source line', () => {
    const onSourceJump = vi.fn();
    initPreview(container, { onSourceJump });
    ctrlClick(container);
    expect(onSourceJump).not.toHaveBeenCalled();
  });

  it('is a no-op when no onSourceJump callback is provided', () => {
    initPreview(container);
    renderMarkdown('para\n', '', container);
    expect(() => ctrlClick(container.querySelector('p'))).not.toThrow();
  });
});
