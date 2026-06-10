import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('sidebar module', () => {
  let mod;

  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = '<div id="app"><div id="file-tree" tabindex="-1"></div></div>';
    mod = await import('../core/sidebar.js');
  });

  it('exports expected functions', () => {
    expect(typeof mod.initSidebar).toBe('function');
    expect(typeof mod.loadDirectory).toBe('function');
    expect(typeof mod.toggleSidebar).toBe('function');
    expect(typeof mod.highlightFile).toBe('function');
  });

  it('toggleSidebar toggles sidebar-collapsed class on #app', () => {
    const app = document.getElementById('app');
    expect(app.classList.contains('sidebar-collapsed')).toBe(false);

    mod.toggleSidebar();
    expect(app.classList.contains('sidebar-collapsed')).toBe(true);

    mod.toggleSidebar();
    expect(app.classList.contains('sidebar-collapsed')).toBe(false);
  });

  it('loadDirectory renders entries after init', () => {
    const container = document.getElementById('file-tree');
    mod.initSidebar(container, vi.fn());

    mod.loadDirectory([
      { name: 'docs', path: '/docs', is_dir: true, children: [] },
      { name: 'readme.md', path: '/readme.md', is_dir: false, children: null },
    ]);

    const items = container.querySelectorAll('.tree-item');
    expect(items.length).toBe(2);
  });

  it('highlightFile marks the correct file as active', () => {
    const container = document.getElementById('file-tree');
    mod.initSidebar(container, vi.fn());

    mod.loadDirectory([
      { name: 'a.md', path: '/a.md', is_dir: false, children: null },
      { name: 'b.md', path: '/b.md', is_dir: false, children: null },
    ]);

    mod.highlightFile('/b.md');

    const active = container.querySelector('.tree-item-label.active');
    expect(active).not.toBeNull();
    expect(active.dataset.path).toBe('/b.md');
  });

  it('show/hide/isSidebarVisible drive the sidebar-collapsed class', () => {
    const app = document.getElementById('app');
    expect(mod.isSidebarVisible()).toBe(true);

    mod.hideSidebar();
    expect(app.classList.contains('sidebar-collapsed')).toBe(true);
    expect(mod.isSidebarVisible()).toBe(false);

    mod.showSidebar();
    expect(app.classList.contains('sidebar-collapsed')).toBe(false);
    expect(mod.isSidebarVisible()).toBe(true);
  });

  it('focusFiler moves focus to the #file-tree container', () => {
    const ft = document.getElementById('file-tree');
    mod.focusFiler();
    expect(document.activeElement).toBe(ft);
  });

  it('nextSidebarFocusAction picks the right step in the focus cycle', () => {
    // hidden → reveal + focus filer
    expect(mod.nextSidebarFocusAction({ visible: false })).toBe('show-filer');
    // visible, focus in filer → outline
    expect(
      mod.nextSidebarFocusAction({ visible: true, focusInFiler: true, focusInOutline: false }),
    ).toBe('focus-outline');
    // visible, focus in outline → hide + return to editor
    expect(
      mod.nextSidebarFocusAction({ visible: true, focusInFiler: false, focusInOutline: true }),
    ).toBe('hide-return');
    // visible, focus elsewhere → focus filer
    expect(
      mod.nextSidebarFocusAction({ visible: true, focusInFiler: false, focusInOutline: false }),
    ).toBe('focus-filer');
  });
});
