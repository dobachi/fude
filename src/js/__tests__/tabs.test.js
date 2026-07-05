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

  it('duplicateTab creates an untitled dirty copy of the content', () => {
    const src = mod.openTab('/docs/hello.md', '# Hello');
    mod.updateTabContent(src.id, '# Hello edited'); // simulate live edits

    const dup = mod.duplicateTab(src.id);

    expect(dup).toBeTruthy();
    expect(dup.id).not.toBe(src.id);
    expect(dup.path).toBeNull(); // scratch buffer, not the same file
    expect(dup.content).toBe('# Hello edited'); // copies current content
    expect(dup.name).toBe('hello.md (コピー)');
    expect(dup.dirty).toBe(true); // unsaved copy
    expect(mod.getActiveTab().id).toBe(dup.id); // becomes active
    expect(mod.getAllTabs().length).toBe(2); // original kept

    // Editing the copy must not touch the original's content.
    mod.updateTabContent(dup.id, 'changed');
    expect(mod.getAllTabs().find((t) => t.id === src.id).content).toBe('# Hello edited');
  });

  it('duplicateTab refuses image tabs and unknown ids', () => {
    const img = mod.openTab('/pic.png', '', { kind: 'image' });
    expect(mod.duplicateTab(img.id)).toBeNull();
    expect(mod.duplicateTab('nope')).toBeNull();
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

  it('closing a dirty tab shows a confirm dialog with the confirm button focused', () => {
    const tab = mod.openTab('/dirty.md', 'x');
    mod.markDirty(tab.id);

    mod.closeTab(tab.id);

    // Dialog appears and the tab is NOT yet closed (awaiting confirmation).
    const overlay = document.querySelector('.settings-overlay');
    expect(overlay).not.toBeNull();
    expect(mod.getAllTabs().length).toBe(1);

    // The confirm button must be focused so the dialog is keyboard-operable.
    const confirmBtn = overlay.querySelector('.btn-confirm');
    expect(document.activeElement).toBe(confirmBtn);
  });

  it('Enter confirms closing a dirty tab from the keyboard', () => {
    const tab = mod.openTab('/dirty.md', 'x');
    mod.markDirty(tab.id);
    mod.closeTab(tab.id);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(document.querySelector('.settings-overlay')).toBeNull();
    expect(mod.getAllTabs().length).toBe(0);
  });

  it('Escape cancels closing a dirty tab from the keyboard', () => {
    const tab = mod.openTab('/dirty.md', 'x');
    mod.markDirty(tab.id);
    mod.closeTab(tab.id);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(document.querySelector('.settings-overlay')).toBeNull();
    expect(mod.getAllTabs().length).toBe(1); // tab survives
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

  it('openTab defaults viewMode to split', () => {
    const tab = mod.openTab('/v.md', 'x');
    expect(tab.viewMode).toBe('split');
  });

  it('openTab honors an explicit viewMode option', () => {
    const tab = mod.openTab('/v.md', 'x', { viewMode: 'preview' });
    expect(tab.viewMode).toBe('preview');
  });

  it('setTabViewMode / getTabViewMode update and read a tab view mode', () => {
    const tab = mod.openTab('/v.md', 'x');
    mod.setTabViewMode(tab.id, 'editor');
    expect(mod.getTabViewMode(tab.id)).toBe('editor');
  });

  it('getTabViewMode falls back to split for unknown tabs', () => {
    expect(mod.getTabViewMode('nope')).toBe('split');
  });

  it('getTabsForSession includes each tab view_mode', () => {
    mod.openTab('/a.md', 'a', { viewMode: 'editor' });
    mod.openTab('/b.md', 'b', { viewMode: 'preview' });
    const session = mod.getTabsForSession();
    expect(session).toHaveLength(2);
    expect(session[0]).toMatchObject({ path: '/a.md', view_mode: 'editor' });
    expect(session[1]).toMatchObject({ path: '/b.md', view_mode: 'preview' });
  });
});
