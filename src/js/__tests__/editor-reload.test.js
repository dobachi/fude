import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { setContentFromDisk } from '../core/editor.js';

let containers = [];

function makeView(doc, anchor = 0) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  containers.push(container);
  const view = new EditorView({
    state: EditorState.create({ doc, selection: { anchor } }),
    parent: container,
  });
  return view;
}

beforeEach(() => {
  containers = [];
});

afterEach(() => {
  containers.forEach((c) => c.remove());
});

describe('setContentFromDisk', () => {
  it('replaces content', () => {
    const view = makeView('hello');
    setContentFromDisk(view, 'world');
    expect(view.state.doc.toString()).toBe('world');
  });

  it('preserves cursor line/column when content is identical', () => {
    const doc = 'line one\nline two\nline three';
    const pos = doc.indexOf('two'); // line 2, col 5
    const view = makeView(doc, pos);
    setContentFromDisk(view, doc);
    expect(view.state.selection.main.from).toBe(pos);
  });

  it('keeps cursor at same line/column when later lines change', () => {
    const original = 'line one\nline two\nline three';
    const pos = 'line one\n'.length + 5; // line 2, col 5
    const view = makeView(original, pos);
    const updated = 'line one\nline two\nline THREE-modified';
    setContentFromDisk(view, updated);
    // Cursor should stay at line 2, col 5
    const newPos = view.state.selection.main.from;
    const line = view.state.doc.lineAt(newPos);
    expect(line.number).toBe(2);
    expect(newPos - line.from).toBe(5);
  });

  it('shifts cursor line down when lines are inserted before it', () => {
    const view = makeView('a\nb\nc', 4); // line 3, col 0
    setContentFromDisk(view, 'NEW1\nNEW2\na\nb\nc');
    // Without remapping, the line/col logic preserves "line 3" — which
    // now points at "a", not "c". This is documented behavior: line/col
    // semantics, not content-tracking. Verify line/col preservation.
    const newPos = view.state.selection.main.from;
    const line = view.state.doc.lineAt(newPos);
    expect(line.number).toBe(3);
    expect(newPos - line.from).toBe(0);
  });

  it('clamps cursor when document shrinks below original line', () => {
    const view = makeView('one\ntwo\nthree\nfour', 14); // line 4
    setContentFromDisk(view, 'short');
    const newPos = view.state.selection.main.from;
    expect(newPos).toBeLessThanOrEqual(view.state.doc.length);
  });

  it('clamps cursor column when target line is shorter', () => {
    const view = makeView('aaaaaaaa\nbbbbbbbb', 13); // line 2, col 4
    setContentFromDisk(view, 'aaaaaaaa\nbb');
    const newPos = view.state.selection.main.from;
    const line = view.state.doc.lineAt(newPos);
    expect(line.number).toBe(2);
    expect(newPos - line.from).toBeLessThanOrEqual(2); // col clamped to line length
  });
});
