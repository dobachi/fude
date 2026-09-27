import { describe, it, expect, beforeEach } from 'vitest';
import {
  showAuthBanner,
  hideAuthBanner,
  isAuthBannerVisible,
  authBannerMessage,
} from '../core/auth-banner.js';

describe('auth banner', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('is not shown until asked for', () => {
    expect(isAuthBannerVisible(document)).toBe(false);
  });

  it('explains the problem and how to fix it', () => {
    showAuthBanner(document);
    const banner = document.getElementById('auth-banner');
    expect(banner).not.toBeNull();
    expect(banner.textContent).toMatch(/not authorized/i);
    expect(banner.textContent).toMatch(/token/i);
    expect(banner.getAttribute('role')).toBe('alert');
  });

  it('does not stack up when shown repeatedly', () => {
    showAuthBanner(document);
    showAuthBanner(document);
    showAuthBanner(document);
    expect(document.querySelectorAll('#auth-banner')).toHaveLength(1);
  });

  it('can be dismissed', () => {
    showAuthBanner(document);
    document.querySelector('.auth-banner-dismiss').click();
    expect(isAuthBannerVisible(document)).toBe(false);
  });

  it('hideAuthBanner is safe when nothing is shown', () => {
    expect(() => hideAuthBanner(document)).not.toThrow();
  });

  // It used to be position:fixed over the top of the window, which covered the
  // menu bar — the very thing the message tells the user to go and use.
  it('goes above the menu bar in the flow, not on top of it', () => {
    document.body.innerHTML =
      '<div id="app"><div id="menu-bar"></div><div id="app-body"></div></div>';
    showAuthBanner(document);

    const app = document.getElementById('app');
    expect(app.firstChild.id).toBe('auth-banner');
    expect(app.children[1].id).toBe('menu-bar');
  });

  it('falls back to the body when there is no #app', () => {
    document.body.innerHTML = '';
    showAuthBanner(document);
    expect(document.body.querySelector('#auth-banner')).not.toBeNull();
  });
});

describe('auth banner lockout (#20)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('says the device is locked out and for how long', () => {
    const msg = authBannerMessage({ lockedOutSec: 14 * 60 + 5 });
    expect(msg).toMatch(/locked out/i);
    expect(msg).toMatch(/about 15 min/);
    expect(msg).toMatch(/restart fude-browser/i);
  });

  it('rounds a short remaining time up to one minute', () => {
    expect(authBannerMessage({ lockedOutSec: 3 })).toMatch(/about 1 min/);
  });

  it('copes with an unknown duration', () => {
    const msg = authBannerMessage({ lockedOutSec: null });
    expect(msg).toMatch(/locked out/i);
    expect(msg).toMatch(/a while/);
  });

  it('keeps the no-key message by default', () => {
    expect(authBannerMessage()).toMatch(/not authorized/i);
  });

  it('updates the text of a banner that is already showing', () => {
    showAuthBanner(document);
    showAuthBanner(document, { lockedOutSec: 600 });
    const banners = document.querySelectorAll('#auth-banner');
    expect(banners).toHaveLength(1);
    expect(banners[0].textContent).toMatch(/locked out/i);
  });
});
