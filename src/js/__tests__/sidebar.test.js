import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('sidebar module', () => {
  let mod;

  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = '<div id="app"><div id="file-tree" tabindex="-1"></div></div>';
    mod = await import('../core/sidebar.js');
  });

  describe('root path (open folder) in the header', () => {
    const rootHtml =
      '<div id="app"><div id="sidebar-header"><span class="sidebar-title">Files</span>' +
      '<button id="sidebar-root" class="sidebar-root is-empty" title=""></button></div>' +
      '<div id="file-tree" tabindex="-1"></div></div>';

    it('rootLabel returns the last segment and keeps bare roots', () => {
      expect(mod.rootLabel('/home/me/notes')).toBe('notes');
      expect(mod.rootLabel('/home/me/notes/')).toBe('notes');
      expect(mod.rootLabel('C:\\Users\\me\\docs')).toBe('docs');
      expect(mod.rootLabel('C:\\Users\\me\\docs\\')).toBe('docs');
      expect(mod.rootLabel('/')).toBe('/');
      expect(mod.rootLabel('C:\\')).toBe('C:\\');
      expect(mod.rootLabel('notes')).toBe('notes');
      expect(mod.rootLabel('')).toBe('');
      expect(mod.rootLabel(null)).toBe('');
    });

    it('shows a placeholder until a folder is opened', () => {
      document.body.innerHTML = rootHtml;
      mod.initSidebar(document.getElementById('file-tree'), vi.fn());
      const el = document.getElementById('sidebar-root');
      expect(el.textContent).toBe('フォルダ未選択');
      expect(el.title).toBe('');
      expect(el.classList.contains('is-empty')).toBe(true);
      expect(mod.getRootPath()).toBe('');
    });

    it('setRootPath shows the folder name and the full path as tooltip', () => {
      document.body.innerHTML = rootHtml;
      mod.initSidebar(document.getElementById('file-tree'), vi.fn());
      mod.setRootPath('/home/me/vault');
      const el = document.getElementById('sidebar-root');
      expect(el.textContent).toBe('vault');
      expect(el.title).toBe('/home/me/vault');
      expect(el.classList.contains('is-empty')).toBe(false);
      expect(mod.getRootPath()).toBe('/home/me/vault');

      // Clearing goes back to the placeholder.
      mod.setRootPath('');
      expect(el.textContent).toBe('フォルダ未選択');
      expect(el.classList.contains('is-empty')).toBe(true);
    });

    it('setRootPath before init is applied once the header exists', () => {
      document.body.innerHTML = rootHtml;
      mod.setRootPath('/v');
      mod.initSidebar(document.getElementById('file-tree'), vi.fn());
      expect(document.getElementById('sidebar-root').textContent).toBe('v');
    });

    it('clicking the root calls onRootClick with the full path, not when empty', () => {
      document.body.innerHTML = rootHtml;
      const onRootClick = vi.fn();
      mod.initSidebar(document.getElementById('file-tree'), vi.fn(), { onRootClick });
      const el = document.getElementById('sidebar-root');

      el.click();
      expect(onRootClick).not.toHaveBeenCalled();

      mod.setRootPath('/home/me/vault');
      el.click();
      expect(onRootClick).toHaveBeenCalledWith('/home/me/vault');
    });

    it('does not throw when the header element is absent', () => {
      mod.initSidebar(document.getElementById('file-tree'), vi.fn());
      expect(() => mod.setRootPath('/x')).not.toThrow();
      expect(mod.getRootPath()).toBe('/x');
    });
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

  it('highlightFile reports whether the file is in the rendered tree', () => {
    const container = document.getElementById('file-tree');
    mod.initSidebar(container, vi.fn());

    mod.loadDirectory([{ name: 'a.md', path: '/a.md', is_dir: false, children: null }]);

    expect(mod.highlightFile('/a.md')).toBe(true);
    expect(mod.highlightFile('/missing.md')).toBe(false);
    expect(container.querySelector('.tree-item-label.active')).toBeNull();
  });

  it('highlightFile expands ancestors and scrolls only when asked', () => {
    const container = document.getElementById('file-tree');
    mod.initSidebar(container, vi.fn());

    mod.loadDirectory([
      {
        name: 'docs',
        path: '/docs',
        is_dir: true,
        children: [{ name: 'deep.md', path: '/docs/deep.md', is_dir: false, children: null }],
      },
    ]);

    const target = container.querySelector('.tree-item-label[data-path="/docs/deep.md"]');
    const scrollIntoView = vi.fn();
    target.scrollIntoView = scrollIntoView;

    expect(mod.highlightFile('/docs/deep.md')).toBe(true);
    expect(container.querySelector('.tree-dir').classList.contains('open')).toBe(true);
    expect(scrollIntoView).not.toHaveBeenCalled();

    expect(mod.highlightFile('/docs/deep.md', { scroll: true })).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
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
