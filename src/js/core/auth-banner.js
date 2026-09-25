// auth-banner.js - Persistent "this tab has no access key" notice.
//
// Browser mode authenticates with a token from the URL. When it is missing or
// stale every API call fails, and each caller catches its own error, so the
// user sees an editor that loads but refuses to save. This says why, once,
// instead of leaving them to infer it.

const BANNER_ID = 'auth-banner';

/**
 * Show the banner. Idempotent — calling it again leaves the existing one alone.
 * @param {Document} doc
 */
export function showAuthBanner(doc = globalThis.document) {
  if (!doc || doc.getElementById(BANNER_ID)) return doc?.getElementById(BANNER_ID) || null;

  const banner = doc.createElement('div');
  banner.id = BANNER_ID;
  banner.setAttribute('role', 'alert');

  const text = doc.createElement('span');
  text.className = 'auth-banner-text';
  text.textContent =
    'Not authorized — this tab has no access key, so files cannot be loaded or saved. ' +
    'Open the URL printed by fude-browser (the one containing ?token=…).';

  const dismiss = doc.createElement('button');
  dismiss.className = 'auth-banner-dismiss';
  dismiss.type = 'button';
  dismiss.setAttribute('aria-label', 'Dismiss');
  dismiss.textContent = '×';
  dismiss.addEventListener('click', () => hideAuthBanner(doc));

  banner.appendChild(text);
  banner.appendChild(dismiss);

  // Sit at the top of #app's flex column so the banner PUSHES the menu bar and
  // workspace down. Overlaying them instead hid the very menu the message tells
  // the user to reach for.
  const app = doc.getElementById('app');
  if (app) app.insertBefore(banner, app.firstChild);
  else (doc.body || doc.documentElement).appendChild(banner);
  return banner;
}

export function hideAuthBanner(doc = globalThis.document) {
  const existing = doc?.getElementById(BANNER_ID);
  if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
}

export function isAuthBannerVisible(doc = globalThis.document) {
  return !!doc?.getElementById(BANNER_ID);
}
