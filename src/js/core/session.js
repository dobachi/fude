// session.js - Session save/restore
import * as backend from '../backend.js';

let saveTimeout = null;
const SAVE_DEBOUNCE = 2000;

export function scheduleSave(getSessionData) {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
    try {
      const session = getSessionData();
      await backend.saveSession(session);
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

export async function saveSessionImmediate(session) {
  if (saveTimeout) clearTimeout(saveTimeout);
  try {
    await backend.saveSession(session);
  } catch (e) {
    console.warn('Failed to save session:', e);
  }
}
