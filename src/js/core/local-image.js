// local-image.js - show images from the user's files in browser mode.
//
// The desktop app points <img> at Tauri's asset protocol. Browser mode has no
// such thing, and an <img> cannot send the auth header every API call needs,
// so a local path used as a src just 404'd: no image ever showed. Instead the
// preview renders a placeholder that names the file (data-local-src), and this
// module fetches the bytes through the authenticated API and swaps in a blob:
// URL. One fetch per path; later renders reuse it.

import { readImageBlob } from '../backend.js';

export const LOCAL_SRC_ATTR = 'data-local-src';

// 1×1 transparent GIF: keeps the <img> valid (no request, no broken-image
// icon) until the real picture arrives.
export const PLACEHOLDER_SRC =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** path -> Promise<string> (the blob: URL) */
const cache = new Map();

const defaultDeps = {
  load: (path) => readImageBlob(path),
  createUrl: (blob) => URL.createObjectURL(blob),
  revokeUrl: (url) => URL.revokeObjectURL(url),
};

/**
 * A displayable URL for a local image, fetched once per path.
 * A failed fetch is not cached, so a later render can try again.
 * @param {string} path absolute path
 * @param {Partial<typeof defaultDeps>} [deps] injectable for tests
 * @returns {Promise<string>}
 */
export function localImageUrl(path, deps = {}) {
  const { load, createUrl } = { ...defaultDeps, ...deps };
  let pending = cache.get(path);
  if (!pending) {
    pending = Promise.resolve()
      .then(() => load(path))
      .then((blob) => createUrl(blob));
    cache.set(path, pending);
    pending.catch(() => {
      if (cache.get(path) === pending) cache.delete(path);
    });
  }
  return pending;
}

/**
 * Drop cached URLs so the next render fetches afresh (e.g. the file changed).
 * No argument clears everything.
 * @param {string} [path]
 * @param {Partial<typeof defaultDeps>} [deps]
 */
export function forgetLocalImage(path, deps = {}) {
  const { revokeUrl } = { ...defaultDeps, ...deps };
  const paths = path === undefined ? [...cache.keys()] : [path];
  for (const p of paths) {
    const pending = cache.get(p);
    cache.delete(p);
    if (pending) pending.then(revokeUrl, () => {});
  }
}

/**
 * Point every placeholder image in `container` at its real picture.
 * Images already resolved (or failed) are skipped, so this is cheap to run
 * after every render.
 * @param {ParentNode} container
 * @param {Partial<typeof defaultDeps>} [deps]
 * @returns {Promise<void>} settles when every image has been tried
 */
export async function resolveLocalImages(container, deps = {}) {
  if (!container) return;
  const imgs = container.querySelectorAll(`img[${LOCAL_SRC_ATTR}]`);
  await Promise.all(
    Array.from(imgs).map(async (img) => {
      if (img.dataset.localState) return;
      img.dataset.localState = 'loading';
      const path = img.getAttribute(LOCAL_SRC_ATTR);
      try {
        const url = await localImageUrl(path, deps);
        // The preview may have re-rendered this block while we waited.
        if (img.isConnected && img.getAttribute(LOCAL_SRC_ATTR) === path) {
          img.src = url;
          img.dataset.localState = 'done';
        }
      } catch (err) {
        img.dataset.localState = 'error';
        img.classList.add('local-image-error');
        // Without a src the browser shows the alt text, so the reader sees
        // which picture is missing instead of an invisible placeholder.
        if (img.isConnected) img.removeAttribute('src');
        img.title = `画像を読み込めませんでした: ${path}`;
        console.warn('Failed to load local image:', path, err);
      }
    }),
  );
}

/**
 * The file-system form of an image src as markdown-it emits it. markdown-it
 * percent-encodes link targets (`画像.png` → `%E7%94%BB%E5%83%8F.png`, a space
 * → `%20`), which is right for a URL but names no file on disk. Malformed
 * escapes are left as written.
 * @param {string} src
 * @returns {string}
 */
export function srcToFilePath(src) {
  try {
    return decodeURIComponent(src);
  } catch {
    return src;
  }
}
