// auth-banner.js - Persistent "this tab has no access key" notice.
//
// Browser mode authenticates with a token from the URL. When it is missing or
// stale every API call fails, and each caller catches its own error, so the
// user sees an editor that loads but refuses to save. This says why, once,
// instead of leaving them to infer it.

const BANNER_ID = 'auth-banner';

/**
 * The banner's text.
 *
 * `lockedOutSec` set (even to null, meaning "unknown") selects the lockout
 * message: the server is refusing this device for a while after too many
 * failed keys, so reopening the URL does not help yet.
 *
 * @param {{lockedOutSec?: number|null}} [opts]
 * @returns {string}
 */
export function authBannerMessage(opts = {}) {
  if ('lockedOutSec' in opts) {
    const sec = opts.lockedOutSec;
    const wait =
      typeof sec === 'number' && sec > 0
        ? `about ${Math.max(1, Math.ceil(sec / 60))} min`
        : 'a while';
    return (
      'Temporarily locked out — the server refused too many attempts with a wrong key from this device. ' +
      `Try again in ${wait} with the URL printed by fude-browser, or restart fude-browser to lift it now.`
    );
  }
  return (
    'Not authorized — this tab has no access key, so files cannot be loaded or saved. ' +
    'Open the URL printed by fude-browser (the one containing ?token=…).'
  );
}

/**
 * Show the banner, or update its text if it is already showing.
 * @param {Document} doc
 * @param {{lockedOutSec?: number|null}} [opts] see authBannerMessage
 */
export function showAuthBanner(doc = globalThis.document, opts = {}) {
  if (!doc) return null;
  const existing = doc.getElementById(BANNER_ID);
  if (existing) {
    const t = existing.querySelector('.auth-banner-text');
    if (t) t.textContent = authBannerMessage(opts);
    return existing;
  }

  const banner = doc.createElement('div');
  banner.id = BANNER_ID;
  banner.setAttribute('role', 'alert');

  const text = doc.createElement('span');
  text.className = 'auth-banner-text';
  text.textContent = authBannerMessage(opts);

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
