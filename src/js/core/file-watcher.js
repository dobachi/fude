// file-watcher.js - External file change handling.
//
// Subscribes to Tauri `file-changed` events, asks the host to watch/unwatch
// individual file paths, and coordinates reloading the editor when a file
// changes on disk. Dirty buffers show a banner; clean buffers reload silently.

import * as backend from '../backend.js';
import { isLocalTauri } from '../backend.js';
import { setContentFromDisk } from './editor.js';

/** @type {((path: string) => void) | null} */
let onExternalChange = null;
let initialized = false;

/**
 * Subscribe to external file-change events.
 * @param {(path: string) => void} handler
 */
export async function initFileWatcher(handler) {
  if (initialized) return;
  initialized = true;
  onExternalChange = handler;

  if (!isLocalTauri()) return; // Browser mode: no native watcher.

  try {
    const { listen } = await import('@tauri-apps/api/event');
    await listen('file-changed', (event) => {
      const path = event.payload?.path;
      if (path && onExternalChange) onExternalChange(path);
    });
  } catch (e) {
    console.warn('Failed to initialize file watcher:', e);
  }
}

/** Begin watching a file path. No-op in browser mode or for null paths. */
export async function watchFile(path) {
  if (!path || !isLocalTauri()) return;
  try {
    await backend.watchFile(path);
  } catch (e) {
    console.warn('watch_file failed:', path, e);
  }
}

/** Stop watching a file path. */
export async function unwatchFile(path) {
  if (!path || !isLocalTauri()) return;
  try {
    await backend.unwatchFile(path);
  } catch (e) {
    console.warn('unwatch_file failed:', path, e);
  }
}

/**
 * Reload a tab's content from disk while preserving cursor + scroll.
 * Caller is responsible for marking the tab clean and re-rendering the preview.
 * @param {string} path
 * @param {import('@codemirror/view').EditorView} view
 * @returns {Promise<string|null>} the new content, or null on failure
 */
export async function reloadFromDisk(path, view) {
  try {
    const content = await backend.readFile(path);
    if (view) setContentFromDisk(view, content);
    return content;
  } catch (e) {
    console.error('Reload failed:', path, e);
    return null;
  }
}

let bannerEl = null;

/**
 * Show a non-modal banner offering to reload an externally-modified file.
 * Subsequent calls replace the existing banner.
 * @param {string} message
 * @param {() => void} onReload
 */
export function showReloadBanner(message, onReload) {
  dismissReloadBanner();
  bannerEl = document.createElement('div');
  bannerEl.className = 'reload-banner';
  bannerEl.innerHTML = `
    <span class="reload-banner-msg"></span>
    <button class="reload-banner-btn">再読込</button>
    <button class="reload-banner-dismiss" aria-label="閉じる">×</button>
  `;
  bannerEl.querySelector('.reload-banner-msg').textContent = message;
  bannerEl.querySelector('.reload-banner-btn').addEventListener('click', () => {
    dismissReloadBanner();
    onReload();
  });
  bannerEl.querySelector('.reload-banner-dismiss').addEventListener('click', dismissReloadBanner);
  document.body.appendChild(bannerEl);
}

export function dismissReloadBanner() {
  if (bannerEl) {
    bannerEl.remove();
    bannerEl = null;
  }
}
