import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Browser mode hands the UI its API token once, through the URL. These cover
// that handoff: the token has to reach every request, and it must not be left
// sitting in the address bar (and therefore in history and the Referer header).

describe('browser-token', () => {
  let originalLocation;
  let replaceState;

  function setLocation(search) {
    delete window.location;
    window.location = {
      origin: 'http://localhost:3000',
      pathname: '/',
      search,
      hash: '',
      protocol: 'http:',
      hostname: 'localhost',
    };
  }

  beforeEach(() => {
    vi.resetModules();
    window.sessionStorage.clear();
    window.localStorage.clear();
    originalLocation = window.location;
    replaceState = vi.fn();
    window.history.replaceState = replaceState;
    setLocation('');
  });

  afterEach(() => {
    window.location = originalLocation;
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  it('captures a token from ?token= and returns it', async () => {
    setLocation('?token=abc123');
    const mod = await import('../browser-token.js');
    expect(mod.captureTokenFromUrl()).toBe('abc123');
    expect(mod.getToken()).toBe('abc123');
  });

  it('strips the token from the address bar', async () => {
    setLocation('?token=abc123');
    const mod = await import('../browser-token.js');
    mod.captureTokenFromUrl();
    expect(replaceState).toHaveBeenCalledWith(null, '', '/');
  });

  it('keeps other query parameters when stripping the token', async () => {
    setLocation('?token=abc123&debug=1');
    const mod = await import('../browser-token.js');
    mod.captureTokenFromUrl();
    expect(replaceState).toHaveBeenCalledWith(null, '', '/?debug=1');
  });

  it('survives a reload: the token comes back from storage', async () => {
    setLocation('?token=abc123');
    const first = await import('../browser-token.js');
    first.captureTokenFromUrl();

    vi.resetModules();
    setLocation('');
    const second = await import('../browser-token.js');
    expect(second.getToken()).toBe('abc123');
  });

  // Regression: the token used to live in sessionStorage, which is per-tab.
  // Combined with stripping it from the URL, every NEW tab (and every bookmark
  // or history entry made after the strip) started with no token, and since
  // each API caller catches its own error the only visible symptom was that
  // saving silently did nothing.
  it('is shared with a new tab, not confined to the one that received it', async () => {
    setLocation('?token=abc123');
    const firstTab = await import('../browser-token.js');
    firstTab.captureTokenFromUrl();

    // A new tab: fresh module state and a fresh sessionStorage, same origin.
    vi.resetModules();
    window.sessionStorage.clear();
    setLocation('');

    const newTab = await import('../browser-token.js');
    expect(newTab.getToken()).toBe('abc123');
    expect(newTab.authHeaders()).toEqual({ 'X-Fude-Token': 'abc123' });
    expect(newTab.isAuthenticated()).toBe(true);
  });

  it('persists the token where a new tab can find it', async () => {
    setLocation('?token=abc123');
    const mod = await import('../browser-token.js');
    mod.captureTokenFromUrl();
    expect(window.localStorage.getItem('fude.browserToken')).toBe('abc123');
  });

  it('isAuthenticated is false with no token', async () => {
    const mod = await import('../browser-token.js');
    expect(mod.isAuthenticated()).toBe(false);
  });

  it('clearToken forgets the token everywhere and announces it', async () => {
    setLocation('?token=abc123');
    const mod = await import('../browser-token.js');
    mod.captureTokenFromUrl();

    const heard = vi.fn();
    window.addEventListener(mod.AUTH_FAILED_EVENT, heard);
    mod.clearToken();

    expect(mod.getToken()).toBe('');
    expect(mod.isAuthenticated()).toBe(false);
    expect(window.localStorage.getItem('fude.browserToken')).toBeNull();
    expect(heard).toHaveBeenCalled();
    window.removeEventListener(mod.AUTH_FAILED_EVENT, heard);
  });

  it('falls back to sessionStorage when localStorage is blocked', async () => {
    // jsdom shares one Storage.prototype between the two, so replace the
    // localStorage object outright rather than spying on the prototype.
    const realLocal = window.localStorage;
    const blocked = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
      removeItem() {
        throw new Error('blocked');
      },
    };
    Object.defineProperty(window, 'localStorage', { value: blocked, configurable: true });

    setLocation('?token=abc123');
    const mod = await import('../browser-token.js');
    mod.captureTokenFromUrl();
    expect(window.sessionStorage.getItem('fude.browserToken')).toBe('abc123');
    expect(mod.authHeaders()).toEqual({ 'X-Fude-Token': 'abc123' });

    Object.defineProperty(window, 'localStorage', { value: realLocal, configurable: true });
  });

  // A rejected token must not come back to life from the URL on the next call.
  it('does not resurrect a rejected token from the URL', async () => {
    setLocation('?token=abc123');
    const mod = await import('../browser-token.js');
    mod.captureTokenFromUrl();
    mod.clearToken();

    // ?token= is still in our mocked location, as it would be if
    // history.replaceState had been refused.
    expect(mod.authHeaders()).toEqual({});
    expect(mod.isAuthenticated()).toBe(false);
  });

  it('accepts a fresh token after a rejection', async () => {
    setLocation('?token=abc123');
    const mod = await import('../browser-token.js');
    mod.captureTokenFromUrl();
    mod.clearToken();
    mod.setToken('newkey');
    expect(mod.authHeaders()).toEqual({ 'X-Fude-Token': 'newkey' });
  });

  it('returns an empty token when none was ever supplied', async () => {
    const mod = await import('../browser-token.js');
    expect(mod.captureTokenFromUrl()).toBe('');
    expect(mod.getToken()).toBe('');
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('authHeaders carries the token', async () => {
    setLocation('?token=abc123');
    const mod = await import('../browser-token.js');
    mod.captureTokenFromUrl();
    expect(mod.authHeaders()).toEqual({ 'X-Fude-Token': 'abc123' });
  });

  it('authHeaders is empty rather than sending a bogus header', async () => {
    const mod = await import('../browser-token.js');
    expect(mod.authHeaders()).toEqual({});
  });

  it('authHeaders recovers the token from the URL if startup never ran', async () => {
    setLocation('?token=late');
    const mod = await import('../browser-token.js');
    expect(mod.authHeaders()).toEqual({ 'X-Fude-Token': 'late' });
  });

  it('survives sessionStorage throwing (private mode)', async () => {
    const setItem = vi.spyOn(window.sessionStorage.__proto__, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const getItem = vi.spyOn(window.sessionStorage.__proto__, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    setLocation('?token=abc123');
    const mod = await import('../browser-token.js');
    expect(mod.captureTokenFromUrl()).toBe('abc123');
    expect(mod.authHeaders()).toEqual({ 'X-Fude-Token': 'abc123' });

    setItem.mockRestore();
    getItem.mockRestore();
  });

  it('survives history.replaceState throwing', async () => {
    window.history.replaceState = vi.fn(() => {
      throw new Error('opaque origin');
    });
    setLocation('?token=abc123');
    const mod = await import('../browser-token.js');
    expect(mod.captureTokenFromUrl()).toBe('abc123');
  });

  it('setToken overrides the stored value', async () => {
    const mod = await import('../browser-token.js');
    mod.setToken('manual');
    expect(mod.getToken()).toBe('manual');
    expect(mod.authHeaders()).toEqual({ 'X-Fude-Token': 'manual' });
  });
});
