import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  openTab,
  closeTab,
  switchTab,
  nextTab,
  prevTab,
  getActiveTab,
  getAllTabs,
  markDirty,
  markClean,
  setTabChangeCallback,
} from '../core/tabs.js';

// tabs.js uses module-level state (tabs array, activeTabId, nextTabId).
// We re-import a fresh module for each test to reset that state.
// Vitest supports this via dynamic import with cache busting.

// Since we cannot easily reset module state without re-importing,
// we structure tests to account for cumulative state within each describe block.
// For isolation we rely on vi.resetModules() + dynamic import.

describe('tabs module', () => {
  let mod;

  beforeEach(async () => {
    // Reset module registry so each test gets fresh module state
    vi.resetModules();

    // Set up minimal DOM
    document.body.innerHTML = '<div id="tab-bar"></div>';

    // Dynamically import to get fresh module state
    mod = await import('../core/tabs.js');
  });

  it('openTab creates a tab and renders it in the DOM', () => {
    const tab = mod.openTab('/docs/hello.md', '# Hello');

    expect(tab).toBeDefined();
    expect(tab.path).toBe('/docs/hello.md');
    expect(tab.name).toBe('hello.md');
    expect(tab.content).toBe('# Hello');
    expect(tab.dirty).toBe(false);

    // Check DOM rendering
    const tabBar = document.getElementById('tab-bar');
    const tabEls = tabBar.querySelectorAll('.tab');
    expect(tabEls.length).toBe(1);
    expect(tabEls[0].classList.contains('active')).toBe(true);
    expect(tabEls[0].querySelector('.tab-name').textContent).toBe('hello.md');
  });

  it('closeTab removes the tab from the list and DOM', () => {
    const tab1 = mod.openTab('/a.md');
    const tab2 = mod.openTab('/b.md');

    mod.closeTab(tab2.id);

    const allTabs = mod.getAllTabs();
    expect(allTabs.length).toBe(1);
    expect(allTabs[0].id).toBe(tab1.id);

    const tabBar = document.getElementById('tab-bar');
    expect(tabBar.querySelectorAll('.tab').length).toBe(1);
  });

  it('switchTab changes the active tab', () => {
    const tab1 = mod.openTab('/a.md');
    const tab2 = mod.openTab('/b.md');

    // tab2 is active after opening
    expect(mod.getActiveTab().id).toBe(tab2.id);

    mod.switchTab(tab1.id);
    expect(mod.getActiveTab().id).toBe(tab1.id);

    // DOM should reflect active state
    const tabBar = document.getElementById('tab-bar');
    const tabEls = tabBar.querySelectorAll('.tab');
    const activeEl = tabBar.querySelector('.tab.active');
    expect(activeEl.dataset.tabId).toBe(tab1.id);
  });

  it('markDirty and markClean toggle dirty state', () => {
    const tab = mod.openTab('/notes.md', 'content');

    expect(tab.dirty).toBe(false);

    mod.markDirty(tab.id);
    expect(mod.getActiveTab().dirty).toBe(true);

    // DOM should have dirty class
    const tabBar = document.getElementById('tab-bar');
    expect(tabBar.querySelector('.tab.dirty')).not.toBeNull();

    mod.markClean(tab.id);
    expect(mod.getActiveTab().dirty).toBe(false);
    expect(tabBar.querySelector('.tab.dirty')).toBeNull();
  });

  it('nextTab and prevTab cycle through tabs', () => {
    const tab1 = mod.openTab('/a.md');
    const tab2 = mod.openTab('/b.md');
    const tab3 = mod.openTab('/c.md');

    // Active is tab3 (last opened)
    expect(mod.getActiveTab().id).toBe(tab3.id);

    // nextTab wraps around to tab1
    mod.nextTab();
    expect(mod.getActiveTab().id).toBe(tab1.id);

    // prevTab wraps back to tab3
    mod.prevTab();
    expect(mod.getActiveTab().id).toBe(tab3.id);

    // prevTab goes to tab2
    mod.prevTab();
    expect(mod.getActiveTab().id).toBe(tab2.id);
  });

  it('opening the same path does not duplicate tabs', () => {
    mod.openTab('/docs/readme.md', 'first');
    mod.openTab('/docs/readme.md', 'second');

    const allTabs = mod.getAllTabs();
    expect(allTabs.length).toBe(1);
    // Content should remain from the first open
    expect(allTabs[0].content).toBe('first');
  });

  it('closing last tab sets active to null', () => {
    const tab = mod.openTab('/only.md');
    mod.closeTab(tab.id);

    expect(mod.getActiveTab()).toBeNull();
    expect(mod.getAllTabs().length).toBe(0);
  });

  it('openTab with no path creates an untitled tab', () => {
    const tab = mod.openTab(null, '');
    expect(tab.name).toBe('Untitled');
    expect(tab.path).toBeNull();
  });
});
