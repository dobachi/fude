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

export async function triggerSave(path, content) {
  if (autosaveTimeout) clearTimeout(autosaveTimeout);
  if (!path) return false;

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
    return false;
  }
}

export async function checkRecovery(paths) {
  try {
    const tempFiles = await backend.checkTempFiles(paths);
    return tempFiles || [];
  } catch {
    return [];
  }
}
