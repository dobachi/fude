import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  localImageUrl,
  forgetLocalImage,
  resolveLocalImages,
  srcToFilePath,
  LOCAL_SRC_ATTR,
  PLACEHOLDER_SRC,
} from '../core/local-image.js';
import { renderMarkdown } from '../core/preview.js';

let n = 0;
const deps = () => ({
  load: vi.fn(async (path) => ({ path })),
  createUrl: vi.fn(() => `blob:test/${++n}`),
  revokeUrl: vi.fn(),
});

afterEach(() => forgetLocalImage(undefined, { revokeUrl: () => {} }));

describe('srcToFilePath', () => {
  it('decodes what markdown-it percent-encoded', () => {
    expect(srcToFilePath('%E7%94%BB%E5%83%8F.png')).toBe('画像.png');
    expect(srcToFilePath('my%20img.png')).toBe('my img.png');
    expect(srcToFilePath('dir/a.png')).toBe('dir/a.png');
  });

  it('leaves malformed escapes as written', () => {
    expect(srcToFilePath('100%.png')).toBe('100%.png');
  });
});

describe('localImageUrl', () => {
  it('fetches a path once and reuses the URL', async () => {
    const d = deps();
    const [a, b] = await Promise.all([localImageUrl('/x.png', d), localImageUrl('/x.png', d)]);
    const c = await localImageUrl('/x.png', d);
    expect(a).toBe(b);
    expect(c).toBe(a);
    expect(d.load).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failure, so a later render retries', async () => {
    const d = deps();
    d.load.mockRejectedValueOnce(new Error('404'));
    await expect(localImageUrl('/y.png', d)).rejects.toThrow('404');
    await expect(localImageUrl('/y.png', d)).resolves.toMatch(/^blob:/);
    expect(d.load).toHaveBeenCalledTimes(2);
  });

  it('forgetLocalImage drops and revokes the cached URL', async () => {
    const d = deps();
    const url = await localImageUrl('/z.png', d);
    forgetLocalImage('/z.png', d);
    await Promise.resolve();
    expect(d.revokeUrl).toHaveBeenCalledWith(url);
    await localImageUrl('/z.png', d);
    expect(d.load).toHaveBeenCalledTimes(2);
  });
});

describe('resolveLocalImages', () => {
  let container;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => container.remove());

  function placeholder(path) {
    const img = document.createElement('img');
    img.src = PLACEHOLDER_SRC;
    img.setAttribute(LOCAL_SRC_ATTR, path);
    container.appendChild(img);
    return img;
  }

  it('swaps placeholders for the fetched pictures', async () => {
    const d = deps();
    const a = placeholder('/a.png');
    const b = placeholder('/b.png');
    await resolveLocalImages(container, d);
    expect(a.src).toMatch(/^blob:/);
    expect(b.src).toMatch(/^blob:/);
    expect(a.src).not.toBe(b.src);
    expect(d.load.mock.calls.map((c) => c[0])).toEqual(['/a.png', '/b.png']);
  });

  it('skips images already handled, so re-running is cheap', async () => {
    const d = deps();
    placeholder('/a.png');
    await resolveLocalImages(container, d);
    await resolveLocalImages(container, d);
    expect(d.load).toHaveBeenCalledTimes(1);
  });

  it('leaves ordinary images alone', async () => {
    const d = deps();
    const img = document.createElement('img');
    img.src = 'https://example.com/x.png';
    container.appendChild(img);
    await resolveLocalImages(container, d);
    expect(img.src).toBe('https://example.com/x.png');
    expect(d.load).not.toHaveBeenCalled();
  });

  it('marks a failed image and drops the placeholder so its alt text shows', async () => {
    const d = deps();
    d.load.mockRejectedValue(new Error('403'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const img = placeholder('/nope.png');
    img.alt = 'diagram';
    await resolveLocalImages(container, d);
    warn.mockRestore();
    expect(img.classList.contains('local-image-error')).toBe(true);
    expect(img.hasAttribute('src')).toBe(false);
    expect(img.title).toMatch(/nope\.png/);
  });

  it('does not touch an image replaced while its fetch was in flight', async () => {
    let release;
    const d = deps();
    d.load.mockImplementation(() => new Promise((r) => (release = () => r({}))));
    const img = placeholder('/slow.png');
    const done = resolveLocalImages(container, d);
    img.setAttribute(LOCAL_SRC_ATTR, '/other.png');
    await Promise.resolve();
    release();
    await done;
    expect(img.getAttribute('src')).toBe(PLACEHOLDER_SRC);
  });
});

describe('preview markup in browser mode', () => {
  it('renders local images as placeholders naming the decoded absolute path', () => {
    const c = document.createElement('div');
    renderMarkdown('![a](画像.png)\n\n![b](<sub dir/b.png>)\n\n![c](/abs/c.png)\n', '/notes', c);
    const imgs = c.querySelectorAll('img');
    expect([...imgs].map((i) => i.getAttribute(LOCAL_SRC_ATTR))).toEqual([
      '/notes/画像.png',
      '/notes/sub dir/b.png',
      '/abs/c.png',
    ]);
    for (const img of imgs) expect(img.getAttribute('src')).toBe(PLACEHOLDER_SRC);
  });

  it('leaves remote and data images untouched', () => {
    const c = document.createElement('div');
    renderMarkdown(
      '![r](https://example.com/r.png)\n\n![d](data:image/png;base64,AA==)\n',
      '/notes',
      c,
    );
    const imgs = c.querySelectorAll('img');
    expect(imgs[0].getAttribute('src')).toBe('https://example.com/r.png');
    expect(imgs[0].hasAttribute(LOCAL_SRC_ATTR)).toBe(false);
    expect(imgs[1].hasAttribute(LOCAL_SRC_ATTR)).toBe(false);
  });
});
