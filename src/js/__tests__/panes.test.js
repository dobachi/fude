import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the editor and preview modules that panes.js imports
vi.mock('../core/editor.js', () => ({
  createEditor: vi.fn(() => ({
    destroy: vi.fn(),
    focus: vi.fn(),
    dom: document.createElement('div'),
  })),
  setTheme: vi.fn(),
  setContent: vi.fn(),
  getContent: vi.fn(() => ''),
}));

vi.mock('../core/preview.js', () => ({
  initPreview: vi.fn(),
}));

describe('panes module', () => {
  let mod;

  beforeEach(async () => {
    vi.resetModules();

    // Set up DOM
    document.body.innerHTML = `
      <div id="workspace">
        <div class="pane" data-pane-id="default">
          <div class="editor-pane"></div>
          <div class="preview-pane"></div>
        </div>
      </div>
    `;

    mod = await import('../core/panes.js');
  });

  it('exports expected functions', () => {
    expect(typeof mod.initPanes).toBe('function');
    expect(typeof mod.splitVertical).toBe('function');
    expect(typeof mod.splitHorizontal).toBe('function');
    expect(typeof mod.closeActivePane).toBe('function');
    expect(typeof mod.focusPane).toBe('function');
    expect(typeof mod.getActivePane).toBe('function');
    expect(typeof mod.getAllPanes).toBe('function');
    expect(typeof mod.getPaneCount).toBe('function');
    expect(typeof mod.setCallbacks).toBe('function');
    expect(typeof mod.createEditorInPane).toBe('function');
    expect(typeof mod.setActivePaneFile).toBe('function');
    expect(typeof mod.clearPanesWithFile).toBe('function');
    expect(typeof mod.applyThemeToAllPanes).toBe('function');
  });

  it('initPanes sets up the default pane', () => {
    mod.initPanes();

    expect(mod.getPaneCount()).toBe(1);
    const pane = mod.getActivePane();
    expect(pane).not.toBeNull();
    expect(pane.id).toBe('default');
    expect(pane.editorContainer).not.toBeNull();
    expect(pane.previewContainer).not.toBeNull();
  });

  it('splitVertical creates a second pane', () => {
    mod.initPanes();

    const newPane = mod.splitVertical();
    expect(newPane).not.toBeNull();
    expect(mod.getPaneCount()).toBe(2);

    // New pane becomes active
    expect(mod.getActivePane().id).toBe(newPane.id);

    // Workspace should have split class
    const workspace = document.getElementById('workspace');
    expect(workspace.classList.contains('split-vertical')).toBe(true);
  });

  it('splitHorizontal creates a second pane with horizontal class', () => {
    mod.initPanes();

    const newPane = mod.splitHorizontal();
    expect(newPane).not.toBeNull();
    expect(mod.getPaneCount()).toBe(2);

    const workspace = document.getElementById('workspace');
    expect(workspace.classList.contains('split-horizontal')).toBe(true);
  });

  it('closeActivePane does nothing with only one pane', () => {
    mod.initPanes();
    expect(mod.getPaneCount()).toBe(1);

    mod.closeActivePane();
    expect(mod.getPaneCount()).toBe(1);
  });

  it('closeActivePane removes a pane when multiple exist', () => {
    mod.initPanes();
    mod.splitVertical();
    expect(mod.getPaneCount()).toBe(2);

    mod.closeActivePane();
    expect(mod.getPaneCount()).toBe(1);
  });

  it('focusPane changes active pane', () => {
    mod.initPanes();
    const newPane = mod.splitVertical();

    // Active is the new pane
    expect(mod.getActivePane().id).toBe(newPane.id);

    // Focus left/up should go to the first pane
    mod.focusPane('left');
    expect(mod.getActivePane().id).toBe('default');

    // Focus right/down should go back
    mod.focusPane('right');
    expect(mod.getActivePane().id).toBe(newPane.id);
  });

  it('focusPane does nothing with only one pane', () => {
    mod.initPanes();
    const paneId = mod.getActivePane().id;
    mod.focusPane('right');
    expect(mod.getActivePane().id).toBe(paneId);
  });

  it('getAllPanes returns a copy of the panes array', () => {
    mod.initPanes();
    const panes = mod.getAllPanes();
    expect(Array.isArray(panes)).toBe(true);
    expect(panes.length).toBe(1);
  });

  it('getActivePaneEditorContainer returns the editor div', () => {
    mod.initPanes();
    const container = mod.getActivePaneEditorContainer();
    expect(container).not.toBeNull();
    expect(container.classList.contains('editor-pane')).toBe(true);
  });

  it('getActivePanePreviewContainer returns the preview div', () => {
    mod.initPanes();
    const container = mod.getActivePanePreviewContainer();
    expect(container).not.toBeNull();
    expect(container.classList.contains('preview-pane')).toBe(true);
  });

  it('setActivePaneFile updates pane file state', () => {
    mod.initPanes();
    mod.setActivePaneFile('/docs/test.md', '# Test', null);

    const pane = mod.getActivePane();
    expect(pane.filePath).toBe('/docs/test.md');
    expect(pane.content).toBe('# Test');
    expect(pane.dirty).toBe(false);
  });

  it('clearPanesWithFile resets panes showing the specified file', () => {
    mod.initPanes();
    mod.setActivePaneFile('/docs/test.md', '# Test', null);

    mod.clearPanesWithFile('/docs/test.md');

    const pane = mod.getActivePane();
    expect(pane.filePath).toBeNull();
    expect(pane.content).toBe('');
    expect(pane.dirty).toBe(false);
  });
});
