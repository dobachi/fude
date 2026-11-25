import { describe, it, expect } from 'vitest';
import {
  DEFAULT_WORKSPACE,
  KEEP_ITEMS,
  defaultKeep,
  normalizeKeep,
  normalizeStore,
  activeWorkspace,
  findWorkspace,
  nameError,
  filterSession,
  withSession,
  addWorkspace,
  renameWorkspace,
  removeWorkspace,
  setKeep,
  setActive,
  switchBlockers,
} from '../core/workspaces.js';

const session = (over = {}) => ({
  open_tabs: [
    { path: '/v/a.md', cursor_line: 0, cursor_col: 0, scroll_top: 0, view_mode: 'preview' },
  ],
  active_tab: 0,
  vault_path: '/v',
  view_mode: 'editor',
  sidebar_visible: false,
  pane_layout: null,
  ...over,
});

const two = () =>
  addWorkspace(normalizeStore(null, session()), 'notes', { ...defaultKeep(), tabs: false });

describe('keep', () => {
  it('keeps everything by default', () => {
    expect(Object.values(defaultKeep()).every(Boolean)).toBe(true);
    expect(Object.keys(defaultKeep())).toEqual(KEEP_ITEMS.map((i) => i.key));
  });

  it('treats missing or odd entries as kept, only false as not', () => {
    expect(normalizeKeep(null)).toEqual(defaultKeep());
    expect(normalizeKeep({ tabs: false, folder: 0, extra: false })).toEqual({
      ...defaultKeep(),
      tabs: false,
    });
  });
});

describe('normalizeStore', () => {
  it('turns the existing session into the default workspace', () => {
    const s = session();
    const store = normalizeStore(null, s);
    expect(store.active).toBe(DEFAULT_WORKSPACE);
    expect(store.workspaces).toEqual([
      { name: DEFAULT_WORKSPACE, keep: defaultKeep(), session: s },
    ]);
  });

  it('starts with an empty default workspace when there is nothing', () => {
    expect(normalizeStore(null, null).workspaces[0].session).toBeNull();
    expect(normalizeStore({ active: 'x', workspaces: [] }).active).toBe(DEFAULT_WORKSPACE);
  });

  it('drops nameless and duplicate workspaces, trims names, fills keep', () => {
    const store = normalizeStore({
      active: 'b',
      workspaces: [
        { name: ' a ', keep: { tabs: false } },
        { name: '' },
        null,
        { name: 'a' },
        { name: 'b', session: 'garbage' },
      ],
    });
    expect(store.workspaces.map((w) => w.name)).toEqual(['a', 'b']);
    expect(store.workspaces[0].keep.tabs).toBe(false);
    expect(store.workspaces[1].session).toBeNull();
    expect(store.active).toBe('b');
  });

  it('falls back to the first workspace when the active one is gone', () => {
    const store = normalizeStore({ active: 'gone', workspaces: [{ name: 'a' }, { name: 'b' }] });
    expect(store.active).toBe('a');
    expect(activeWorkspace(store).name).toBe('a');
  });

  it('prefers the stored workspaces over the legacy session', () => {
    const store = normalizeStore({ active: 'a', workspaces: [{ name: 'a' }] }, session());
    expect(store.workspaces).toHaveLength(1);
    expect(store.workspaces[0].session).toBeNull();
  });
});

describe('nameError', () => {
  const store = two();
  it('rejects empty, too long and taken names', () => {
    expect(nameError('  ', store)).toMatch(/入力/);
    expect(nameError('x'.repeat(65), store)).toMatch(/64/);
    expect(nameError('notes', store)).toMatch(/既に/);
    expect(nameError(' notes ', store)).toMatch(/既に/);
  });
  it('accepts a free name, and a name kept by a rename to itself', () => {
    expect(nameError('仕事', store)).toBeNull();
    expect(nameError('notes', store, { except: 'notes' })).toBeNull();
  });
});

describe('filterSession', () => {
  it('keeps everything when everything is kept', () => {
    expect(filterSession(session(), defaultKeep())).toEqual(session());
  });

  it('drops what is not kept, leaving fresh-start values', () => {
    const out = filterSession(session(), {
      folder: false,
      tabs: true,
      view_mode: false,
      sidebar: false,
    });
    expect(out.vault_path).toBeNull();
    expect(out.open_tabs.map((t) => t.path)).toEqual(['/v/a.md']);
    expect(out.open_tabs[0].view_mode).toBe('split');
    expect(out.view_mode).toBe('split');
    expect(out.sidebar_visible).toBe(true);
  });

  it('drops the tabs and the active index together', () => {
    const out = filterSession(session({ active_tab: 3 }), { ...defaultKeep(), tabs: false });
    expect(out.open_tabs).toEqual([]);
    expect(out.active_tab).toBe(0);
    expect(out.vault_path).toBe('/v');
  });

  it('does not modify its input and tolerates no session', () => {
    const s = session();
    filterSession(s, { folder: false });
    expect(s.vault_path).toBe('/v');
    expect(filterSession(null, defaultKeep())).toBeNull();
  });
});

describe('store operations', () => {
  it('records a session per workspace, filtered by that workspace', () => {
    let store = two();
    store = withSession(store, 'notes', session({ vault_path: '/notes' }));
    expect(findWorkspace(store, 'notes').session.vault_path).toBe('/notes');
    expect(findWorkspace(store, 'notes').session.open_tabs).toEqual([]); // not kept
    expect(findWorkspace(store, DEFAULT_WORKSPACE).session.vault_path).toBe('/v');
    expect(withSession(store, 'nope', session())).toBe(store);
  });

  it('adds an empty workspace, refusing a bad name', () => {
    const store = two();
    expect(findWorkspace(store, 'notes').session).toBeNull();
    expect(() => addWorkspace(store, 'notes')).toThrow(/既に/);
    expect(() => addWorkspace(store, '')).toThrow();
  });

  it('renames, following the active workspace', () => {
    let store = setActive(two(), 'notes');
    store = renameWorkspace(store, 'notes', '執筆');
    expect(store.active).toBe('執筆');
    expect(findWorkspace(store, 'notes')).toBeUndefined();
    store = renameWorkspace(store, DEFAULT_WORKSPACE, '仕事');
    expect(store.active).toBe('執筆');
    expect(() => renameWorkspace(store, '仕事', '執筆')).toThrow(/既に/);
  });

  it('removes a workspace, never the last, moving off a removed active one', () => {
    let store = setActive(two(), 'notes');
    store = removeWorkspace(store, 'notes');
    expect(store.active).toBe(DEFAULT_WORKSPACE);
    expect(store.workspaces).toHaveLength(1);
    expect(() => removeWorkspace(store, DEFAULT_WORKSPACE)).toThrow(/最後/);
  });

  it('changing keep drops what is no longer kept from the saved session', () => {
    let store = normalizeStore(null, session());
    store = setKeep(store, DEFAULT_WORKSPACE, { ...defaultKeep(), folder: false });
    const ws = activeWorkspace(store);
    expect(ws.keep.folder).toBe(false);
    expect(ws.session.vault_path).toBeNull();
    expect(ws.session.open_tabs).toHaveLength(1);
  });

  it('setActive ignores unknown names', () => {
    const store = two();
    expect(setActive(store, 'nope')).toBe(store);
    expect(setActive(store, 'notes').active).toBe('notes');
  });
});

describe('switchBlockers', () => {
  it('allows a switch with no unsaved tabs', () => {
    expect(switchBlockers([{ path: '/a.md', dirty: false }])).toEqual({ ok: true, dirty: [] });
    expect(switchBlockers(null).ok).toBe(true);
  });

  it('names the unsaved tabs', () => {
    const r = switchBlockers([
      { path: '/v/a.md', dirty: true },
      { path: 'C:\\v\\b.md', dirty: true },
      { path: null, dirty: true },
      { path: '/v/c.md', dirty: false },
    ]);
    expect(r).toEqual({ ok: false, dirty: ['a.md', 'b.md', 'Untitled'] });
  });
});
