import { describe, it, expect, vi } from 'vitest';
import { isImagePath, mimeToExt, insertImageMarkdown } from '../core/image-insert.js';

describe('isImagePath', () => {
  it('recognizes common image extensions (case-insensitive)', () => {
    expect(isImagePath('photo.png')).toBe(true);
    expect(isImagePath('/abs/path/IMG.JPG')).toBe(true);
    expect(isImagePath('a.jpeg')).toBe(true);
    expect(isImagePath('icon.svg')).toBe(true);
    expect(isImagePath('anim.GIF')).toBe(true);
    expect(isImagePath('pic.webp')).toBe(true);
  });

  it('rejects non-image and edge-case paths', () => {
    expect(isImagePath('note.md')).toBe(false);
    expect(isImagePath('archive.zip')).toBe(false);
    expect(isImagePath('noextension')).toBe(false);
    expect(isImagePath('')).toBe(false);
    expect(isImagePath(null)).toBe(false);
    expect(isImagePath(undefined)).toBe(false);
  });
});

describe('mimeToExt', () => {
  it('maps image MIME types to extensions', () => {
    expect(mimeToExt('image/png')).toBe('png');
    expect(mimeToExt('image/jpeg')).toBe('jpg');
    expect(mimeToExt('image/gif')).toBe('gif');
    expect(mimeToExt('image/webp')).toBe('webp');
    expect(mimeToExt('image/svg+xml')).toBe('svg');
  });

  it('falls back to png for missing/unknown input', () => {
    expect(mimeToExt('')).toBe('png');
    expect(mimeToExt(null)).toBe('png');
    expect(mimeToExt('image/')).toBe('png');
  });
});

describe('insertImageMarkdown', () => {
  it('dispatches a Markdown image at the selection', () => {
    const replaceSelection = vi.fn().mockReturnValue('SPEC');
    const dispatch = vi.fn();
    const view = { state: { replaceSelection }, dispatch };

    insertImageMarkdown(view, 'assets/photo.png');

    expect(replaceSelection).toHaveBeenCalledWith('![](assets/photo.png)');
    expect(dispatch).toHaveBeenCalledWith('SPEC', { scrollIntoView: true });
  });

  it('includes alt text when provided', () => {
    const replaceSelection = vi.fn().mockReturnValue('SPEC');
    const view = { state: { replaceSelection }, dispatch: vi.fn() };

    insertImageMarkdown(view, 'assets/x.png', 'my alt');

    expect(replaceSelection).toHaveBeenCalledWith('![my alt](assets/x.png)');
  });

  it('does nothing without a view or path', () => {
    expect(() => insertImageMarkdown(null, 'a.png')).not.toThrow();
    const view = { state: { replaceSelection: vi.fn() }, dispatch: vi.fn() };
    insertImageMarkdown(view, '');
    expect(view.dispatch).not.toHaveBeenCalled();
  });
});
