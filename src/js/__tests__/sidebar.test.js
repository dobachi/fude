import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('sidebar module', () => {
  let mod;

  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = '<div id="app"><div id="file-tree"></div></div>';
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
});
