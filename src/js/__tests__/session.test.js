import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../backend.js', () => ({
  saveSession: vi.fn().mockResolvedValue(undefined),
  loadSession: vi.fn().mockResolvedValue(null),
}));

describe('session module', () => {
  let mod;
  let backend;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();

    backend = await import('../backend.js');
    mod = await import('../core/session.js');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('exports expected functions', () => {
    expect(typeof mod.scheduleSave).toBe('function');
    expect(typeof mod.restoreSession).toBe('function');
    expect(typeof mod.saveSessionImmediate).toBe('function');
  });

  it('scheduleSave debounces and calls saveSession', async () => {
    const getData = vi.fn(() => ({ open_tabs: [], active_tab: 0 }));

    mod.scheduleSave(getData);

    // Not called immediately
    expect(backend.saveSession).not.toHaveBeenCalled();

    // Advance past debounce
    vi.advanceTimersByTime(2500);
    await vi.runAllTimersAsync();

    expect(getData).toHaveBeenCalled();
    expect(backend.saveSession).toHaveBeenCalledWith({ open_tabs: [], active_tab: 0 });
  });

  it('scheduleSave resets debounce on rapid calls', async () => {
    const getData1 = vi.fn(() => ({ version: 1 }));
    const getData2 = vi.fn(() => ({ version: 2 }));

    mod.scheduleSave(getData1);
    vi.advanceTimersByTime(1000);
    mod.scheduleSave(getData2);

    // Clear prior calls before the final debounce fires
    backend.saveSession.mockClear();

    vi.advanceTimersByTime(2500);
    await vi.runAllTimersAsync();

    expect(getData1).not.toHaveBeenCalled();
    expect(getData2).toHaveBeenCalled();
    expect(backend.saveSession).toHaveBeenCalledTimes(1);
    expect(backend.saveSession).toHaveBeenCalledWith({ version: 2 });
  });

  it('restoreSession returns session data', async () => {
    const mockSession = { open_tabs: [{ path: '/a.md' }], active_tab: 0 };
    backend.loadSession.mockResolvedValueOnce(mockSession);

    const result = await mod.restoreSession();
    expect(result).toEqual(mockSession);
  });

  it('restoreSession returns null on error', async () => {
    backend.loadSession.mockRejectedValueOnce(new Error('fail'));

    const result = await mod.restoreSession();
    expect(result).toBeNull();
  });

  it('saveSessionImmediate saves without debounce', async () => {
    const session = { open_tabs: [], active_tab: 0 };
    await mod.saveSessionImmediate(session);

    expect(backend.saveSession).toHaveBeenCalledWith(session);
  });
});
