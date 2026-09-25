import { describe, it, expect, beforeEach } from 'vitest';
import { showAuthBanner, hideAuthBanner, isAuthBannerVisible } from '../core/auth-banner.js';

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
