import { describe, it, expect, vi } from 'vitest';
import { createWaitTracker } from '../core/wait-tracker.js';

describe('createWaitTracker', () => {
  it('reports a clean close as saved and forgets the path', () => {
    const notify = vi.fn();
    const t = createWaitTracker(notify);
    t.add('/w/a.md');
    expect(t.has('/w/a.md')).toBe(true);

    t.onPathChange({ oldPath: '/w/a.md', newPath: null, dirty: false });
    expect(notify).toHaveBeenCalledWith('/w/a.md', true);
    expect(t.has('/w/a.md')).toBe(false);
    expect(t.list()).toEqual([]);
  });

  it('reports a dirty close as not saved', () => {
    const notify = vi.fn();
    const t = createWaitTracker(notify);
    t.add('/w/a.md');
    t.onPathChange({ oldPath: '/w/a.md', newPath: null, dirty: true });
    expect(notify).toHaveBeenCalledWith('/w/a.md', false);
  });

  it('ignores tabs nobody is waiting on', () => {
    const notify = vi.fn();
    const t = createWaitTracker(notify);
    t.add('/w/a.md');
    t.onPathChange({ oldPath: '/w/other.md', newPath: null });
    t.onPathChange({ oldPath: null, newPath: '/w/new.md' });
    expect(notify).not.toHaveBeenCalled();
    expect(t.has('/w/a.md')).toBe(true);
  });

  it('follows a rename and still reports the path the caller asked for', () => {
    const notify = vi.fn();
    const t = createWaitTracker(notify);
    t.add('/w/a.md');
    t.onPathChange({ oldPath: '/w/a.md', newPath: '/w/b.md' });
    expect(t.has('/w/a.md')).toBe(false);
    expect(t.has('/w/b.md')).toBe(true);
    expect(t.list()).toEqual(['/w/a.md']);

    t.onPathChange({ oldPath: '/w/b.md', newPath: null, dirty: false });
    expect(notify).toHaveBeenCalledWith('/w/a.md', true);
  });

  it('is idempotent on add and tolerates empty paths', () => {
    const notify = vi.fn();
    const t = createWaitTracker(notify);
    t.add('/w/a.md');
    t.add('/w/a.md');
    t.add('');
    t.add(null);
    expect(t.list()).toEqual(['/w/a.md']);
    expect(t.has('')).toBe(false);
  });

  it('matches WSL UNC aliases of the same path', () => {
    const notify = vi.fn();
    const t = createWaitTracker(notify);
    t.add('\\\\wsl$\\Ubuntu\\home\\u\\a.md');
    t.onPathChange({ oldPath: '\\\\wsl.localhost\\Ubuntu\\home\\u\\a.md', newPath: null });
    expect(notify).toHaveBeenCalledWith('\\\\wsl$\\Ubuntu\\home\\u\\a.md', true);
  });
});
