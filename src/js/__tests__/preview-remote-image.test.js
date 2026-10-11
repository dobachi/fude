// Images of a document that lives on a remote agent's machine (a tab opened
// by `fude FILE` over ssh). Regression: they were handed to the asset
// protocol as if local, and never showed.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const readImageBlob = vi.fn();
vi.mock('../backend.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isLocalTauri: () => true, readImageBlob: (...a) => readImageBlob(...a) };
});
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (p) => `asset://localhost/${p}`,
  invoke: vi.fn(),
}));

import { renderPreview, initPreview } from '../core/preview.js';
import { LOCAL_SRC_ATTR, PLACEHOLDER_SRC, forgetLocalImage } from '../core/local-image.js';

let container;
const BASE = 'remote://k16/home/u/docs';
// renderPreview is what the app calls: it also runs the pass that fetches images.
const render = (text, base) => renderPreview(text, base, container, `${base}/n.md`);
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  initPreview(container, {});
  readImageBlob.mockReset();
  forgetLocalImage();
  globalThis.URL.createObjectURL = vi.fn((blob) => `blob:fake/${blob.size}`);
  globalThis.URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  container.remove();
});

describe('images in a remote document', () => {
  it('are fetched from the agent by their remote path and shown', async () => {
    readImageBlob.mockResolvedValue(new Blob(['12345'], { type: 'image/png' }));
    await render('![pic](img/a.png)', BASE);
    await settle();
    const img = container.querySelector('img');
    expect(img.getAttribute(LOCAL_SRC_ATTR)).toBe('remote://k16/home/u/docs/img/a.png');
    expect(readImageBlob).toHaveBeenCalledWith('remote://k16/home/u/docs/img/a.png');
    expect(img.getAttribute('src')).toBe('blob:fake/5');
    // Never the asset protocol, which only reaches this machine's files.
    expect(container.innerHTML).not.toContain('asset://');
  });

  it('resolve parent directories, host-absolute paths and encoded names', async () => {
    readImageBlob.mockResolvedValue(new Blob(['x']));
    await render(
      '![a](../assets/a.png)\n\n![b](/var/img/b.png)\n\n![c](img/%E7%94%BB%E5%83%8F%20c.png)',
      BASE,
    );
    await settle();
    const names = [...container.querySelectorAll('img')].map((i) => i.getAttribute(LOCAL_SRC_ATTR));
    expect(names).toEqual([
      'remote://k16/home/u/assets/a.png',
      'remote://k16/var/img/b.png',
      'remote://k16/home/u/docs/img/画像 c.png',
    ]);
  });

  it('leave web and data images alone', async () => {
    await render('![w](https://example.com/w.png)\n\n![d](data:image/png;base64,AAAA)', BASE);
    await settle();
    const imgs = [...container.querySelectorAll('img')];
    expect(imgs.map((i) => i.getAttribute('src'))).toEqual([
      'https://example.com/w.png',
      'data:image/png;base64,AAAA',
    ]);
    expect(imgs.some((i) => i.hasAttribute(LOCAL_SRC_ATTR))).toBe(false);
    expect(readImageBlob).not.toHaveBeenCalled();
  });

  it('show the alt text and the reason when the agent cannot serve one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    readImageBlob.mockRejectedValue(new Error('outside what this fude-cli serves'));
    await render('![missing](/etc/x.png)', BASE);
    await settle();
    const img = container.querySelector('img');
    expect(img.dataset.localState).toBe('error');
    expect(img.hasAttribute('src')).toBe(false);
    expect(img.title).toContain('remote://k16/etc/x.png');
    warn.mockRestore();
  });

  it('a local document on the desktop still uses the asset protocol', async () => {
    await render('![pic](img/a.png)', '/home/u/docs');
    await settle();
    const img = container.querySelector('img');
    expect(img.getAttribute('src')).toBe('asset://localhost//home/u/docs/img/a.png');
    expect(img.hasAttribute(LOCAL_SRC_ATTR)).toBe(false);
    expect(img.getAttribute('src')).not.toBe(PLACEHOLDER_SRC);
    expect(readImageBlob).not.toHaveBeenCalled();
  });
});
