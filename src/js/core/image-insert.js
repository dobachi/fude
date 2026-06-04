// image-insert.js - Shared helpers for inserting images via drag-drop / paste.

/** Image file extensions we treat as insertable images. */
export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'];

/** Returns true if the given path/filename has a known image extension. */
export function isImagePath(path) {
  if (!path) return false;
  const dot = path.lastIndexOf('.');
  if (dot < 0) return false;
  const ext = path.slice(dot + 1).toLowerCase();
  return IMAGE_EXTS.includes(ext);
}

/** Maps an image MIME type (e.g. "image/png") to a file extension ("png"). */
export function mimeToExt(mimeType) {
  if (!mimeType) return 'png';
  const sub = mimeType.split('/')[1] || '';
  const ext = sub.toLowerCase();
  if (ext === 'jpeg') return 'jpg';
  if (ext === 'svg+xml') return 'svg';
  return ext || 'png';
}

/**
 * Inserts a Markdown image reference at the current selection.
 * @param {import('@codemirror/view').EditorView} view
 * @param {string} relPath - relative path to insert, e.g. "assets/photo.png"
 * @param {string} [alt] - optional alt text
 */
export function insertImageMarkdown(view, relPath, alt = '') {
  if (!view || !relPath) return;
  view.dispatch(view.state.replaceSelection(`![${alt}](${relPath})`), {
    scrollIntoView: true,
  });
}
