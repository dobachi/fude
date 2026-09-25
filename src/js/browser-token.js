// browser-token.js - Session token for browser mode.
//
// The HTTP fallback server (scripts/serve.js) requires a token on every /api/*
// call, because that API can read and write anything the user can. The token
// arrives once in the URL the server prints (`/?token=...`); we move it into
// storage and strip it from the address bar so it does not linger in history,
// bookmarks or the Referer of any link the user follows.
//
// Storage is localStorage, NOT sessionStorage: sessionStorage is per-tab, so
// combined with stripping the URL it left every new tab, duplicated tab and
// bookmark without a token — and because each failed call is caught and
// reported per-operation, that surfaced as "saving silently does nothing"
// rather than as "you are not logged in".

const STORAGE_KEY = 'fude.browserToken';
export const TOKEN_HEADER = 'X-Fude-Token';
export const AUTH_FAILED_EVENT = 'fude:auth-required';

let memoryToken = '';
// Set once the server has rejected this token. Without it, the URL fallback in
// currentToken() would read the same rejected token straight back out of
// ?token= and retry forever.
let rejected = false;

// localStorage first (shared across tabs of this origin), sessionStorage as a
// fallback, then memory. Any of them can throw in a locked-down browser.
function stores() {
  const out = [];
  try {
    if (window.localStorage) out.push(window.localStorage);
  } catch {
    /* blocked */
  }
  try {
    if (window.sessionStorage) out.push(window.sessionStorage);
  } catch {
    /* blocked */
  }
  return out;
}

function readStored() {
  for (const store of stores()) {
    try {
      const v = store.getItem(STORAGE_KEY);
      if (v) return v;
    } catch {
      /* try the next one */
    }
  }
  return '';
}

function writeStored(token) {
  for (const store of stores()) {
    try {
      store.setItem(STORAGE_KEY, token);
    } catch {
      /* best effort; memoryToken still holds it for this page */
    }
  }
}

function removeStored() {
  for (const store of stores()) {
    try {
      store.removeItem(STORAGE_KEY);
    } catch {
      /* nothing to do */
    }
  }
}

/**
 * Take the token out of `?token=...` if present, remember it, and rewrite the
 * URL without it. Safe to call more than once.
 */
export function captureTokenFromUrl() {
  if (typeof window === 'undefined' || !window.location) return '';

  let params;
  try {
    params = new URLSearchParams(window.location.search || '');
  } catch {
    return getToken();
  }

  const fromUrl = params.get('token');
  if (fromUrl) {
    memoryToken = fromUrl;
    rejected = false;
    writeStored(fromUrl);

    params.delete('token');
    const query = params.toString();
    const clean =
      window.location.pathname + (query ? `?${query}` : '') + (window.location.hash || '');
    try {
      window.history.replaceState(null, '', clean);
    } catch {
      /* non-browser host or opaque origin; the token is already stored */
    }
  }
  return getToken();
}

export function getToken() {
  if (memoryToken) return memoryToken;
  memoryToken = readStored();
  return memoryToken;
}

/**
 * Token for outgoing requests. Falls back to reading the URL in case a caller
 * fires before startup got to `captureTokenFromUrl`.
 */
function currentToken() {
  if (rejected) return '';
  const known = getToken();
  if (known) return known;
  return captureTokenFromUrl();
}

/** For tests and for the "token changed" recovery path. */
export function setToken(token) {
  memoryToken = token || '';
  rejected = false;
  if (token) writeStored(token);
  else removeStored();
}

/**
 * Forget the token and tell the app. Called when the server rejects it, which
 * means it is stale (the server regenerated its key) or was never supplied —
 * either way, keeping it around only produces more silent failures.
 */
export function clearToken() {
  memoryToken = '';
  rejected = true;
  removeStored();
  try {
    window.dispatchEvent(new CustomEvent(AUTH_FAILED_EVENT));
  } catch {
    /* no CustomEvent in this host */
  }
}

/** True when this tab has no usable token at all. */
export function isAuthenticated() {
  return currentToken() !== '';
}

/** Headers to merge into every browser-mode API request. */
export function authHeaders() {
  const token = currentToken();
  return token ? { [TOKEN_HEADER]: token } : {};
}
