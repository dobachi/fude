import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EditorView } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultKeymap } from '@codemirror/commands';
import { keymap } from '@codemirror/view';

let container;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  container.remove();
});

function dispatchKey(view, key, code, opts = {}) {
  const ev = new KeyboardEvent('keydown', {
    key,
    code,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    ...opts,
  });
  view.contentDOM.dispatchEvent(ev);
  return ev;
}

describe('emacs extension', () => {
  it('Ctrl+A moves cursor to line start (not selectAll)', async () => {
    const { emacs } = await import('@replit/codemirror-emacs');
    const compartment = new Compartment();
    const view = new EditorView({
      state: EditorState.create({
        doc: 'first line\nsecond line\nthird line',
        selection: { anchor: 18 }, // middle of "second line"
        extensions: [compartment.of(emacs()), keymap.of(defaultKeymap)],
      }),
      parent: container,
    });

    dispatchKey(view, 'a', 'KeyA');

    // After Ctrl+A in emacs: cursor at start of line 2 (offset 11)
    const sel = view.state.selection.main;
    expect(sel.from).toBe(11);
    expect(sel.from).toBe(sel.to); // not a selection, just cursor

    view.destroy();
  });

  it('Ctrl+E moves cursor to line end', async () => {
    const { emacs } = await import('@replit/codemirror-emacs');
    const compartment = new Compartment();
    const view = new EditorView({
      state: EditorState.create({
        doc: 'first line\nsecond line\nthird line',
        selection: { anchor: 14 }, // middle of "second line"
        extensions: [compartment.of(emacs()), keymap.of(defaultKeymap)],
      }),
      parent: container,
    });

    dispatchKey(view, 'e', 'KeyE');

    // line 2 ends at offset 22 ("first line\nsecond line")
    expect(view.state.selection.main.from).toBe(22);

    view.destroy();
  });

  it('without emacs, Ctrl+A selects all (defaultKeymap)', async () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: 'hello world',
        extensions: [keymap.of(defaultKeymap)],
      }),
      parent: container,
    });

    dispatchKey(view, 'a', 'KeyA');

    const sel = view.state.selection.main;
    expect(sel.from).toBe(0);
    expect(sel.to).toBe(11); // entire doc selected

    view.destroy();
  });

  it('Fude editor: Ctrl+A in emacs mode goes to line start (not selectAll)', async () => {
    // Replicate the actual Fude createEditor extension order
    const { createEditor, toggleEmacs } = await import('../core/editor.js');
    const view = createEditor(container, 'first line\nsecond line\nthird line');
    // Place cursor in middle of "second line"
    view.dispatch({ selection: { anchor: 18 } });

    await toggleEmacs(view, true);

    // Wait a tick for the dispatch to settle
    await new Promise((r) => setTimeout(r, 0));

    dispatchKey(view, 'a', 'KeyA');

    const sel = view.state.selection.main;
    // Should be at start of line 2 (offset 11), NOT a selection
    expect(sel.from).toBe(11);
    expect(sel.from).toBe(sel.to);

    view.destroy();
  });

  it('Fude editor: switching vim → emacs activates emacs bindings', async () => {
    const { createEditor, toggleVim, toggleEmacs } = await import('../core/editor.js');
    const view = createEditor(container, 'first line\nsecond line');
    view.dispatch({ selection: { anchor: 14 } });

    await toggleVim(view, true);
    await new Promise((r) => setTimeout(r, 0));
    // Switch to emacs (mimics setMode flow)
    await toggleEmacs(view, true);
    await new Promise((r) => setTimeout(r, 0));

    dispatchKey(view, 'a', 'KeyA');

    const sel = view.state.selection.main;
    expect(sel.from).toBe(11);
    expect(sel.from).toBe(sel.to);

    view.destroy();
  });
});
