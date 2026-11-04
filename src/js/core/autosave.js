// autosave.js - Auto-save and crash recovery
import * as backend from '../backend.js';

let autosaveTimeout = null;
const AUTOSAVE_DEBOUNCE = 2000;

export function onContentChange(path, content) {
  if (!path) return;

  if (autosaveTimeout) clearTimeout(autosaveTimeout);
  autosaveTimeout = setTimeout(async () => {
    try {
      await backend.writeTempFile(path, content);
    } catch (e) {
      console.warn('Autosave failed:', e);
    }
  }, AUTOSAVE_DEBOUNCE);
}

/**
 * Write `content` to `path`. Resolves true on success. A failed write used to
 * be logged only, so the save looked done; `onError` gets a message to show.
 * @param {string} path
 * @param {string} content
 * @param {{onError?: (message: string) => void}} [opts]
 */
export async function triggerSave(path, content, opts = {}) {
  if (autosaveTimeout) clearTimeout(autosaveTimeout);
  if (!path) return false;

  const release = noteWriting(path, content);
  try {
    await backend.writeFile(path, content);
    try {
      await backend.deleteTempFile(path);
    } catch {
      /* ignore */
    }
    return true;
  } catch (e) {
    console.error('Save failed:', e);
    if (opts.onError) opts.onError(`保存できませんでした: ${e?.message || e}`);
    return false;
  } finally {
    release();
  }
}

/**
 * How long a save's content is still remembered after the write finished.
 * The watcher's report of that write can arrive after the save's reply
 * (a remote agent sends it over the connection, independently).
 */
export const WRITE_ECHO_GRACE_MS = 3000;

/** @type {Map<string, string[]>} path → contents being (or just) written */
const writing = new Map();

function noteWriting(path, content) {
  const list = writing.get(path) || [];
  list.push(content);
  writing.set(path, list);
  return () => {
    setTimeout(() => {
      const cur = writing.get(path);
      if (!cur) return;
      const i = cur.indexOf(content);
      if (i >= 0) cur.splice(i, 1);
      if (cur.length === 0) writing.delete(path);
    }, WRITE_ECHO_GRACE_MS);
  };
}

/**
 * Contents Fude's own saves are writing to `path`, or wrote a moment ago.
 * @param {string} path
 * @returns {string[]}
 */
export function contentsBeingWritten(path) {
  return [...(writing.get(path) || [])];
}

export async function checkRecovery(paths) {
  try {
    const tempFiles = await backend.checkTempFiles(paths);
    return tempFiles || [];
  } catch {
    return [];
  }
}
