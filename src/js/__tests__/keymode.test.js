import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../core/editor.js', () => ({
  toggleVim: vi.fn().mockResolvedValue(undefined),
  getCurrentView: vi.fn(() => null),
}));

vi.mock('../core/panes.js', () => ({
  getAllPanes: vi.fn(() => []),
}));

describe('keymode module', () => {
  let mod;
  let editor;
  let panes;

  beforeEach(async () => {
    vi.resetModules();

    editor = await import('../core/editor.js');
    panes = await import('../core/panes.js');
    mod = await import('../core/keymode.js');
  });

  it('exports expected functions', () => {
    expect(typeof mod.initKeymode).toBe('function');
    expect(typeof mod.setMode).toBe('function');
    expect(typeof mod.getMode).toBe('function');
    expect(typeof mod.cycleMode).toBe('function');
    expect(typeof mod.reapplyMode).toBe('function');
  });

  it('getMode returns normal by default', () => {
    expect(mod.getMode()).toBe('normal');
  });

  it('setMode changes the current mode', async () => {
    await mod.setMode('vim');
    expect(mod.getMode()).toBe('vim');

    await mod.setMode('normal');
    expect(mod.getMode()).toBe('normal');
  });

  it('setMode calls toggleVim on pane editor views', async () => {
    const mockView = { destroy: vi.fn() };
    panes.getAllPanes.mockReturnValue([{ editorView: mockView }]);

    await mod.setMode('vim');
    expect(editor.toggleVim).toHaveBeenCalledWith(mockView, true);

    editor.toggleVim.mockClear();
    await mod.setMode('normal');
    expect(editor.toggleVim).toHaveBeenCalledWith(mockView, false);
  });

  it('cycleMode cycles from normal to vim', async () => {
    expect(mod.getMode()).toBe('normal');

    const next = await mod.cycleMode();
    expect(next).toBe('vim');
    expect(mod.getMode()).toBe('vim');
  });

  it('cycleMode cycles from vim back to normal', async () => {
    await mod.setMode('vim');

    const next = await mod.cycleMode();
    expect(next).toBe('normal');
    expect(mod.getMode()).toBe('normal');
  });

  it('initKeymode sets the initial mode', async () => {
    await mod.initKeymode('vim');
    expect(mod.getMode()).toBe('vim');
  });

  it('reapplyMode re-applies the current mode', async () => {
    await mod.setMode('vim');
    editor.toggleVim.mockClear();

    await mod.reapplyMode();
    expect(mod.getMode()).toBe('vim');
    // toggleVim should have been called again
    expect(editor.toggleVim).toHaveBeenCalled();
  });
});
