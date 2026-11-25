// session.js - Session save/restore
import * as backend from '../backend.js';

let saveTimeout = null;
const SAVE_DEBOUNCE = 2000;

/**
 * Debounced save. `save` writes the session out; by default straight to
 * session.json, the app passes one that also records it in the workspace.
 */
export function scheduleSave(getSessionData, save = backend.saveSession) {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
    try {
      const session = getSessionData();
      await save(session);
    } catch (e) {
      console.warn('Failed to save session:', e);
    }
  }, SAVE_DEBOUNCE);
}

export async function restoreSession() {
  try {
    return await backend.loadSession();
  } catch (e) {
    console.warn('Failed to restore session:', e);
    return null;
  }
}

export async function saveSessionImmediate(session, save = backend.saveSession) {
  if (saveTimeout) clearTimeout(saveTimeout);
  try {
    await save(session);
  } catch (e) {
    console.warn('Failed to save session:', e);
  }
}
