import { describe, it, expect } from 'vitest';
import { isInsideRoot, planStartup, startupNotice } from '../core/startup-plan.js';

describe('isInsideRoot', () => {
  it('accepts the root itself and anything below it', () => {
    expect(isInsideRoot('/r', '/r')).toBe(true);
    expect(isInsideRoot('/r/a/b.md', '/r')).toBe(true);
    expect(isInsideRoot('/r/a', '/r/')).toBe(true);
  });

  it('rejects siblings that merely share a prefix', () => {
    expect(isInsideRoot('/rx/a.md', '/r')).toBe(false);
    expect(isInsideRoot('/other/a.md', '/r')).toBe(false);
  });

  it('treats no root as no confinement', () => {
    expect(isInsideRoot('/anything', null)).toBe(true);
    expect(isInsideRoot('/anything', '')).toBe(true);
  });

  it('handles "/" as root and Windows separators', () => {
    expect(isInsideRoot('/a', '/')).toBe(true);
    expect(isInsideRoot('C:\\r\\a.md', 'C:/r')).toBe(true);
    expect(isInsideRoot('C:\\rx\\a.md', 'C:\\r')).toBe(false);
  });

  it('rejects an empty path under a root', () => {
    expect(isInsideRoot('', '/r')).toBe(false);
  });
});

const tab = (path) => ({ path, cursor_line: 0 });

describe('planStartup', () => {
  it('desktop (no launch options): restores the session as before', () => {
    const session = { vault_path: '/v', open_tabs: [tab('/v/a.md'), tab('/x/b.md')] };
    const plan = planStartup({ session, startup: null });
    expect(plan).toEqual({
      vault: '/v',
      tabs: session.open_tabs,
      restoreSession: true,
      skipped: [],
    });
  });

  it('desktop: a session without tabs is not restored, folder included', () => {
    const plan = planStartup({ session: { vault_path: '/v', open_tabs: [] }, startup: null });
    expect(plan.restoreSession).toBe(false);
    expect(plan.vault).toBeNull();
  });

  it('no session at all opens --open-dir', () => {
    const plan = planStartup({ session: null, startup: { open_dir: '/r/sub', root: '/r' } });
    expect(plan).toMatchObject({ vault: '/r/sub', restoreSession: false, tabs: [] });
  });

  it('no session and no --open-dir falls back to --root', () => {
    const plan = planStartup({ session: null, startup: { open_dir: null, root: '/r' } });
    expect(plan.vault).toBe('/r');
  });

  // The situation in #21.
  it('drops a session that lies entirely outside --root and opens --open-dir', () => {
    const session = { vault_path: '/b', open_tabs: [tab('/b/1.md'), tab('/b/2.md')] };
    const plan = planStartup({ session, startup: { open_dir: '/r/sub', root: '/r' } });
    expect(plan.restoreSession).toBe(false);
    expect(plan.vault).toBe('/r/sub');
    expect(plan.tabs).toEqual([]);
    expect(plan.skipped).toEqual(['/b/1.md', '/b/2.md']);
  });

  it('keeps the tabs inside --root and reports the rest', () => {
    const session = { vault_path: '/b', open_tabs: [tab('/r/in.md'), tab('/b/out.md')] };
    const plan = planStartup({ session, startup: { open_dir: null, root: '/r' } });
    expect(plan.restoreSession).toBe(true);
    expect(plan.tabs.map((t) => t.path)).toEqual(['/r/in.md']);
    expect(plan.skipped).toEqual(['/b/out.md', '/b']);
    expect(plan.vault).toBe('/r'); // session folder unusable → --root
  });

  it('--open-dir wins over the session folder', () => {
    const session = { vault_path: '/r/old', open_tabs: [tab('/r/a.md')] };
    const plan = planStartup({ session, startup: { open_dir: '/r/new', root: '/r' } });
    expect(plan.vault).toBe('/r/new');
    expect(plan.skipped).toEqual([]);
  });

  it('keeps the session folder when it is usable and no --open-dir is given', () => {
    const session = { vault_path: '/r/old', open_tabs: [tab('/r/a.md')] };
    const plan = planStartup({ session, startup: { open_dir: null, root: '/r' } });
    expect(plan.vault).toBe('/r/old');
  });

  it('ignores tab entries without a path', () => {
    const session = { vault_path: null, open_tabs: [tab(null), null, tab('/r/a.md')] };
    const plan = planStartup({ session, startup: { open_dir: null, root: '/r' } });
    expect(plan.tabs.map((t) => t.path)).toEqual(['/r/a.md']);
    expect(plan.skipped).toEqual([]);
  });

  it('survives a malformed session', () => {
    expect(planStartup({ session: { open_tabs: 'x' }, startup: null }).restoreSession).toBe(false);
    expect(planStartup({ session: {}, startup: {} }).vault).toBeNull();
  });
});

describe('startupNotice', () => {
  it('is null when nothing went wrong', () => {
    expect(startupNotice({})).toBeNull();
    expect(startupNotice({ skipped: [], failed: [] })).toBeNull();
    expect(startupNotice()).toBeNull();
  });

  it('names what was skipped for being outside --root', () => {
    const msg = startupNotice({ skipped: ['/b/1.md', '/b/2.md'] });
    expect(msg).toMatch(/2 件/);
    expect(msg).toMatch(/--root/);
    expect(msg).toMatch(/1\.md, 2\.md/);
  });

  it('names what failed to load, shortening long lists', () => {
    const msg = startupNotice({ failed: ['/a/1', '/a/2', '/a/3', '/a/4'] });
    expect(msg).toMatch(/4 件を読み込めませんでした/);
    expect(msg).toMatch(/1, 2, 3 ほか/);
  });

  it('reports both kinds together', () => {
    const msg = startupNotice({ skipped: ['/b/x.md'], failed: ['C:\\r\\y.md'] });
    expect(msg).toMatch(/x\.md/);
    expect(msg).toMatch(/y\.md/);
  });
});
