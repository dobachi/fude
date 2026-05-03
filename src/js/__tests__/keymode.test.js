import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../core/editor.js', () => ({
  toggleVim: vi.fn().mockResolvedValue(undefined),
  toggleEmacs: vi.fn().mockResolvedValue(undefined),
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
    document.body.innerHTML = '';

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
    expect(typeof mod.updateModeIndicator).toBe('function');
  });

  it('getMode returns normal by default', () => {
    expect(mod.getMode()).toBe('normal');
  });

  it('setMode changes the current mode', async () => {
    await mod.setMode('vim');
    expect(mod.getMode()).toBe('vim');

    await mod.setMode('emacs');
    expect(mod.getMode()).toBe('emacs');

    await mod.setMode('normal');
    expect(mod.getMode()).toBe('normal');
  });

  it('setMode calls toggleVim when entering vim', async () => {
    const mockView = { destroy: vi.fn() };
    panes.getAllPanes.mockReturnValue([{ editorView: mockView }]);

    await mod.setMode('vim');
    expect(editor.toggleVim).toHaveBeenCalledWith(mockView, true);
  });

  it('setMode calls toggleEmacs when entering emacs', async () => {
    const mockView = { destroy: vi.fn() };
    panes.getAllPanes.mockReturnValue([{ editorView: mockView }]);

    editor.toggleEmacs.mockClear();
    await mod.setMode('emacs');
    expect(editor.toggleEmacs).toHaveBeenCalledWith(mockView, true);
  });

  it('setMode clears extensions when entering normal', async () => {
    const mockView = { destroy: vi.fn() };
    panes.getAllPanes.mockReturnValue([{ editorView: mockView }]);

    editor.toggleVim.mockClear();
    await mod.setMode('normal');
    expect(editor.toggleVim).toHaveBeenCalledWith(mockView, false);
  });

  it('cycleMode cycles normal → vim → emacs → normal', async () => {
    expect(mod.getMode()).toBe('normal');

    let next = await mod.cycleMode();
    expect(next).toBe('vim');

    next = await mod.cycleMode();
    expect(next).toBe('emacs');

    next = await mod.cycleMode();
    expect(next).toBe('normal');
  });

  it('initKeymode sets the initial mode', async () => {
    await mod.initKeymode('emacs');
    expect(mod.getMode()).toBe('emacs');
  });

  it('initKeymode falls back to normal for unknown mode', async () => {
    await mod.initKeymode('something-bogus');
    expect(mod.getMode()).toBe('normal');
  });

  it('reapplyMode re-applies the current mode', async () => {
    await mod.setMode('vim');
    editor.toggleVim.mockClear();

    await mod.reapplyMode();
    expect(mod.getMode()).toBe('vim');
    // applied via the same dispatch path
    const view = editor.getCurrentView();
    if (view) {
      expect(editor.toggleVim).toHaveBeenCalled();
    }
  });

  it('updateModeIndicator shows NORMAL badge (always visible)', () => {
    mod.updateModeIndicator('normal');
    const el = document.getElementById('mode-indicator');
    expect(el).not.toBeNull();
    expect(el.hidden).toBe(false);
    expect(el.textContent).toBe('NORMAL');
  });

  it('updateModeIndicator shows VIM badge', () => {
    mod.updateModeIndicator('vim');
    const el = document.getElementById('mode-indicator');
    expect(el.textContent).toBe('VIM');
    expect(el.hidden).toBe(false);
  });

  it('updateModeIndicator shows EMACS badge', () => {
    mod.updateModeIndicator('emacs');
    const el = document.getElementById('mode-indicator');
    expect(el.textContent).toBe('EMACS');
    expect(el.hidden).toBe(false);
  });

  it('setAppVersion appends version to badge', () => {
    mod.setAppVersion('0.2.18');
    mod.updateModeIndicator('emacs');
    const el = document.getElementById('mode-indicator');
    expect(el.textContent).toBe('EMACS · v0.2.18');
  });

  it('getAppVersion returns the set version', () => {
    mod.setAppVersion('1.2.3');
    expect(mod.getAppVersion()).toBe('1.2.3');
  });
});
