import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('menubar module', () => {
  let mod;
  let barEl;

  beforeEach(async () => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="menu-bar" class="hidden"></div>';
    barEl = document.getElementById('menu-bar');
    mod = await import('../core/menubar.js');
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  const menus = [
    { label: 'ファイル', items: [{ label: '新規', action: () => {} }] },
    { label: '編集', items: [{ label: '太字', action: () => {} }] },
  ];

  // In the desktop app a bare Alt tap reveals the hidden bar. A browser claims
  // Alt for its own menu, so starting hidden there left every one of these
  // commands with no discoverable route.
  describe('default visibility', () => {
    it('starts hidden when that is the default (desktop)', () => {
      mod.initMenuBar(barEl, menus, { defaultVisible: false });
      expect(mod.isMenuBarVisible()).toBe(false);
    });

    it('starts visible when that is the default (browser mode)', () => {
      mod.initMenuBar(barEl, menus, { defaultVisible: true });
      expect(mod.isMenuBarVisible()).toBe(true);
      expect(barEl.classList.contains('hidden')).toBe(false);
    });

    it('keeps starting hidden when no default is given', () => {
      mod.initMenuBar(barEl, menus);
      expect(mod.isMenuBarVisible()).toBe(false);
    });

    it('an explicit choice beats the default', () => {
      localStorage.setItem('fude.menuBarVisible', '0');
      mod.initMenuBar(barEl, menus, { defaultVisible: true });
      expect(mod.isMenuBarVisible()).toBe(false);
    });

    it('an explicit choice to show beats a hidden default', () => {
      localStorage.setItem('fude.menuBarVisible', '1');
      mod.initMenuBar(barEl, menus, { defaultVisible: false });
      expect(mod.isMenuBarVisible()).toBe(true);
    });

    it('hiding it in browser mode sticks across a restart', () => {
      mod.initMenuBar(barEl, menus, { defaultVisible: true });
      mod.setMenuBarVisible(false);

      barEl.className = '';
      mod.initMenuBar(barEl, menus, { defaultVisible: true });
      expect(mod.isMenuBarVisible()).toBe(false);
    });
  });

  describe('getStoredMenuBarVisible', () => {
    it('returns the default when nothing is stored', () => {
      expect(mod.getStoredMenuBarVisible(true)).toBe(true);
      expect(mod.getStoredMenuBarVisible(false)).toBe(false);
      expect(mod.getStoredMenuBarVisible()).toBe(false);
    });

    it('returns the stored value when there is one', () => {
      localStorage.setItem('fude.menuBarVisible', '1');
      expect(mod.getStoredMenuBarVisible(false)).toBe(true);
      localStorage.setItem('fude.menuBarVisible', '0');
      expect(mod.getStoredMenuBarVisible(true)).toBe(false);
    });
  });

  it('renders a button per top-level menu', () => {
    mod.initMenuBar(barEl, menus);
    const btns = barEl.querySelectorAll('.menu-bar-item');
    expect(btns.length).toBe(2);
    expect(btns[0].textContent).toBe('ファイル');
  });

  it('is hidden by default (no stored preference)', () => {
    mod.initMenuBar(barEl, menus);
    expect(mod.isMenuBarVisible()).toBe(false);
    expect(barEl.classList.contains('hidden')).toBe(true);
  });

  it('toggleMenuBar shows then hides and persists', () => {
    mod.initMenuBar(barEl, menus);

    mod.toggleMenuBar();
    expect(mod.isMenuBarVisible()).toBe(true);
    expect(barEl.classList.contains('hidden')).toBe(false);
    expect(localStorage.getItem('fude.menuBarVisible')).toBe('1');

    mod.toggleMenuBar();
    expect(mod.isMenuBarVisible()).toBe(false);
    expect(localStorage.getItem('fude.menuBarVisible')).toBe('0');
  });

  it('restores a stored visible preference on init', () => {
    localStorage.setItem('fude.menuBarVisible', '1');
    mod.initMenuBar(barEl, menus);
    expect(mod.isMenuBarVisible()).toBe(true);
  });

  it('clicking a top-level item opens a dropdown', () => {
    mod.initMenuBar(barEl, menus);
    mod.setMenuBarVisible(true);
    barEl.querySelectorAll('.menu-bar-item')[0].click();
    expect(document.querySelector('.context-menu')).not.toBeNull();
  });
});
