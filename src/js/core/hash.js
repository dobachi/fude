// hash.js - Content hashing for external-change detection.
//
// Uses Web Crypto (available in the Tauri webview and in Node 20+/jsdom), so
// there's no dependency and the same hash is computed everywhere on the JS side.

/**
 * SHA-256 of a string, as lowercase hex. Returns null if Web Crypto is
 * unavailable (callers then fall back to skipping the conflict check).
 * @param {string} text
 * @returns {Promise<string|null>}
 */
export async function sha256Hex(text) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const bytes = new TextEncoder().encode(text ?? '');
  const digest = await subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
