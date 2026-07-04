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

  it('nextSidebarFocusAction loops filer ⇄ outline without hiding', () => {
    // hidden → reveal + focus filer
    expect(mod.nextSidebarFocusAction({ visible: false })).toBe('show-filer');
    // visible, focus in filer → outline
    expect(mod.nextSidebarFocusAction({ visible: true, focusInFiler: true })).toBe('focus-outline');
    // visible, focus in outline (not filer) → back to filer (never 'hide')
    expect(mod.nextSidebarFocusAction({ visible: true, focusInFiler: false })).toBe('focus-filer');
  });

  it('focusFiler focuses the active file item when present', () => {
    const container = document.getElementById('file-tree');
    mod.initSidebar(container, vi.fn());
    mod.loadDirectory([
      { name: 'a.md', path: '/a.md', is_dir: false, children: null },
      { name: 'b.md', path: '/b.md', is_dir: false, children: null },
    ]);
    mod.highlightFile('/b.md');

    mod.focusFiler();

    expect(document.activeElement.dataset.path).toBe('/b.md');
  });

  it('keeps expanded directories open across a re-render (refresh)', () => {
    const container = document.getElementById('file-tree');
    mod.initSidebar(container, vi.fn());

    const tree = [
      {
        name: 'docs',
        path: '/docs',
        is_dir: true,
        children: [{ name: 'a.md', path: '/docs/a.md', is_dir: false, children: null }],
      },
    ];
    mod.loadDirectory(tree);

    // Expand the directory by clicking its label.
    const dir = container.querySelector('.tree-dir');
    expect(dir.classList.contains('open')).toBe(false);
    dir.querySelector('.tree-item-label').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(dir.classList.contains('open')).toBe(true);

    // A refresh (e.g. external file change) re-renders the whole tree.
    mod.loadDirectory([
      {
        name: 'docs',
        path: '/docs',
        is_dir: true,
        children: [
          { name: 'a.md', path: '/docs/a.md', is_dir: false, children: null },
          { name: 'b.md', path: '/docs/b.md', is_dir: false, children: null },
        ],
      },
    ]);

    // The directory stays expanded and the new file is visible.
    const dirAfter = container.querySelector('.tree-dir');
    expect(dirAfter.classList.contains('open')).toBe(true);
    expect(dirAfter.querySelector('.tree-icon').textContent).toBe('▼');
    expect(container.querySelector('.tree-item-label[data-path="/docs/b.md"]')).not.toBeNull();
  });

  it('Down arrow moves focus to the next file item; Enter opens it', () => {
    const container = document.getElementById('file-tree');
    const onSelect = vi.fn();
    mod.initSidebar(container, onSelect);
    mod.loadDirectory([
      { name: 'a.md', path: '/a.md', is_dir: false, children: null },
      { name: 'b.md', path: '/b.md', is_dir: false, children: null },
    ]);
    mod.focusFiler(); // first item (a.md)
    expect(document.activeElement.dataset.path).toBe('/a.md');

    container.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement.dataset.path).toBe('/b.md');

    container.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onSelect).toHaveBeenCalledWith('/b.md');
  });
});
