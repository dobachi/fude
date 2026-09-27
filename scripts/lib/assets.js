// assets.js - save a pasted image into the `assets/` folder beside a document.
//
// Browser mode's counterpart of the desktop command of the same name
// (src-tauri: save_image_bytes): same folder, same "pasted-image.<ext>" name,
// same "-1", "-2"... suffix when the name is taken, same relative path back.
//
// Stricter than the desktop version, because here the request comes over the
// network: the extension must be a known image type (it is interpolated into a
// file name, so "../x" must never get through), and an existing file is never
// overwritten, even if it appears between the check and the write.

const fs = require('fs');
const path = require('path');

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);

/**
 * The extension to save under: lower-cased, without a leading dot, defaulting
 * to "png" when empty. Null when it is not a known image extension.
 * @param {string|undefined|null} ext
 * @returns {string|null}
 */
function normalizeImageExt(ext) {
  const e = String(ext == null ? '' : ext)
    .trim()
    .replace(/^\./, '')
    .toLowerCase();
  if (!e) return 'png';
  return IMAGE_EXTS.has(e) ? e : null;
}

/**
 * Candidate file names in order: "stem.ext", "stem-1.ext", "stem-2.ext", ...
 * @param {string} stem
 * @param {string} ext
 * @param {number} n 0 for the plain name
 */
function candidateName(stem, ext, n) {
  return n === 0 ? `${stem}.${ext}` : `${stem}-${n}.${ext}`;
}

/**
 * Write `bytes` as a new image in `<dir of docPath>/assets/`.
 *
 * @param {{docPath: string, bytes: Buffer, ext?: string}} args
 * @param {{maxTries?: number}} [opts]
 * @returns {string} the path to put in the Markdown, e.g. "assets/pasted-image-1.png"
 * @throws on a bad extension, a missing document path, or a write failure
 */
function saveImageBytes({ docPath, bytes, ext }, { maxTries = 10000 } = {}) {
  if (typeof docPath !== 'string' || !docPath) throw new Error('docPath is required');
  if (!Buffer.isBuffer(bytes)) throw new Error('image bytes are required');
  const e = normalizeImageExt(ext);
  if (!e) throw new Error(`Not an image extension: ${ext}`);

  const assets = path.join(path.dirname(docPath), 'assets');
  fs.mkdirSync(assets, { recursive: true });

  for (let n = 0; n < maxTries; n++) {
    const name = candidateName('pasted-image', e, n);
    try {
      // 'wx' fails if the file exists, so two pastes at once cannot both
      // claim the same name and one overwrite the other.
      fs.writeFileSync(path.join(assets, name), bytes, { flag: 'wx' });
      return `assets/${name}`;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error('Could not find a free file name in assets/');
}

/**
 * The image bytes from a request: base64 (what the browser sends; 1.33× the
 * size) or a plain byte array (the desktop command's shape; kept so either
 * client works).
 * @param {{base64?: string, bytes?: number[]}} args
 * @returns {Buffer|null}
 */
function imageBytesFromArgs(args) {
  if (args && typeof args.base64 === 'string') return Buffer.from(args.base64, 'base64');
  if (args && Array.isArray(args.bytes)) return Buffer.from(args.bytes);
  return null;
}

module.exports = { normalizeImageExt, saveImageBytes, imageBytesFromArgs, IMAGE_EXTS };
