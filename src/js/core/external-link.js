// external-link.js - Open URLs in the OS default browser instead of the
// Tauri webview. In browser/dev mode (no Tauri runtime) fall back to
// window.open so the dev experience stays usable.
import { isLocalTauri } from '../backend.js';

const URL_PATTERN = /^(https?:\/\/|mailto:)/i;

/**
 * Decide whether a string looks like a link we are willing to hand off to
 * the OS. Local/relative paths and asset:// URLs are deliberately rejected
 * so internal navigation (images, file links) is handled elsewhere.
 */
export function isExternalUrl(text) {
  return typeof text === 'string' && URL_PATTERN.test(text.trim());
}

/**
 * Open the given URL in the OS default browser (or mail client for mailto:).
 * Returns true if the open was dispatched (Tauri) or window.open returned
 * a handle (browser); false otherwise. Errors are swallowed and logged.
 */
export async function openExternal(url) {
  if (!isExternalUrl(url)) return false;
  const target = url.trim();
  try {
    if (isLocalTauri()) {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(target);
      return true;
    }
    // Browser/dev fallback: regular new-tab open.
    const w = window.open(target, '_blank', 'noopener,noreferrer');
    return Boolean(w);
  } catch (err) {
    console.error('openExternal failed:', err);
    return false;
  }
}

/**
 * Walk up from a click target to find the nearest <a> with an external href.
 * Returns the URL string, or null if none.
 */
export function externalHrefFromEvent(e) {
  const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
  if (!a) return null;
  const href = a.getAttribute('href');
  return isExternalUrl(href) ? href : null;
}
