import { describe, it, expect, afterEach } from 'vitest';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import {
  createEditor,
  createInlineEditor,
  setMarkdownAssist,
  setSourceCodeMode,
} from '../core/editor.js';
import { taskMarkerCompletion } from '../core/task-list.js';

// The Markdown input assist through the real editor: "- [" → "- [ ] ", and the
// switch that turns every assist (this one, list continuation, marker removal)
// off at once.
const containers = [];
afterEach(() => {
  setMarkdownAssist(true);
  for (const c of containers.splice(0)) c.remove();
});

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  containers.push(container);
  return container;
}

function place(view, text) {
  const caret = text.indexOf('|');
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text.replace('|', '') },
    selection: { anchor: caret },
  });
  return view;
}

function editorWith(text, opts) {
  return place(createEditor(mount(), '', null, null, null, opts), text);
}

// Typing a character: the input handlers first, as the DOM observer does,
// then the plain insertion when none of them took it.
function type(view, ch) {
  const { from, to } = view.state.selection.main;
  const handled = view.state
    .facet(EditorView.inputHandler)
    .some((h) =>
      h(view, from, to, ch, () => view.state.update({ changes: { from, to, insert: ch } })),
    );
  if (!handled) {
    view.dispatch({ changes: { from, to, insert: ch }, selection: { anchor: from + ch.length } });
  }
}

function key(view, k, keyCode) {
  return runScopeHandlers(
    view,
    new KeyboardEvent('keydown', { key: k, keyCode, bubbles: true }),
    'editor',
  );
}

const text = (view) => view.state.doc.toString();
const caret = (view) => view.state.selection.main.head;

describe('taskMarkerCompletion', () => {
  it('completes after a bare list prefix', () => {
    expect(taskMarkerCompletion('- ', '')).toBe('[ ] ');
    expect(taskMarkerCompletion('  * ', '')).toBe('[ ] ');
    expect(taskMarkerCompletion('+ ', '  ')).toBe('[ ] ');
    expect(taskMarkerCompletion('1. ', '')).toBe('[ ] ');
    expect(taskMarkerCompletion('12) ', '')).toBe('[ ] ');
    expect(taskMarkerCompletion('> - ', '')).toBe('[ ] ');
  });

  it('leaves everything else alone', () => {
    expect(taskMarkerCompletion('', '')).toBeNull();
    expect(taskMarkerCompletion('-', '')).toBeNull(); // no space yet
    expect(taskMarkerCompletion('- foo ', '')).toBeNull(); // text before
    expect(taskMarkerCompletion('- ', 'foo')).toBeNull(); // text after
    expect(taskMarkerCompletion('see ', '')).toBeNull();
    expect(taskMarkerCompletion('-- ', '')).toBeNull();
  });
});

describe('"- [" completion in the editor', () => {
  it('turns "- [" into "- [ ] " with the caret after it', () => {
    const view = editorWith('- |');
    type(view, '[');
    expect(text(view)).toBe('- [ ] ');
    expect(caret(view)).toBe(6);
    view.destroy();
  });

  it('works on a nested and on a numbered item', () => {
    const view = editorWith('- a\n  - |');
    type(view, '[');
    expect(text(view)).toBe('- a\n  - [ ] ');
    place(view, '1. |');
    type(view, '[');
    expect(text(view)).toBe('1. [ ] ');
    view.destroy();
  });

  it('Backspace right after takes it back to "- [", for a link', () => {
    const view = editorWith('- |');
    type(view, '[');
    expect(key(view, 'Backspace', 8)).toBe(true);
    expect(text(view)).toBe('- [');
    expect(caret(view)).toBe(3);
    type(view, 'a');
    expect(text(view)).toBe('- [a');
    view.destroy();
  });

  it('once something else was typed, Backspace is the usual one', () => {
    const view = editorWith('- |');
    type(view, '[');
    type(view, 'x');
    key(view, 'Backspace', 8);
    expect(text(view)).toBe('- [ ] ');
    view.destroy();
  });

  it('does not complete outside a list or inside a code block', () => {
    const view = editorWith('see |');
    type(view, '[');
    expect(text(view)).toBe('see [');
    place(view, '```\n- |\n```');
    type(view, '[');
    expect(text(view)).toBe('```\n- [\n```');
    view.destroy();
  });

  it('does not complete in a source file opened as code', () => {
    setSourceCodeMode(true);
    try {
      const view = editorWith('- |', { filePath: '/tmp/a.py' });
      type(view, '[');
      expect(text(view)).toBe('- [');
      view.destroy();
    } finally {
      setSourceCodeMode(false);
    }
  });

  it('works in the inline (preview) editor too', () => {
    const view = createInlineEditor(mount(), '- ', {}, 2);
    type(view, '[');
    expect(text(view)).toBe('- [ ] ');
    view.destroy();
  });
});

describe('the Markdown input assist switch', () => {
  it('off: "[" is just "["', () => {
    setMarkdownAssist(false);
    const view = editorWith('- |');
    type(view, '[');
    expect(text(view)).toBe('- [');
    view.destroy();
  });

  it('off: Enter on a list item does not continue the list', () => {
    setMarkdownAssist(false);
    const view = editorWith('- item|');
    key(view, 'Enter', 13);
    expect(text(view)).toBe('- item\n');
    view.destroy();
  });

  it('on: Enter continues the list', () => {
    const view = editorWith('- item|');
    key(view, 'Enter', 13);
    expect(text(view)).toBe('- item\n- ');
    view.destroy();
  });

  it('off: Backspace after a marker deletes one character', () => {
    setMarkdownAssist(false);
    const view = editorWith('- [ ] |todo');
    key(view, 'Backspace', 8);
    expect(text(view)).toBe('- [ ]todo');
    view.destroy();
  });

  it('applies to an editor that is already open', () => {
    const view = editorWith('- |');
    setMarkdownAssist(false);
    type(view, '[');
    expect(text(view)).toBe('- [');
    view.destroy();
  });
});
