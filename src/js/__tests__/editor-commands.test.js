import { describe, it, expect, afterEach } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { toggleBold, toggleBullet, toggleNumbered } from '../core/editor.js';

// jsdom has no layout; stub the Range APIs CodeMirror measures with.
const ZERO = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => [];
  Range.prototype.getBoundingClientRect = () => ZERO;
}

let containers = [];
afterEach(() => {
  containers.forEach((c) => c.remove());
  containers = [];
});

function makeView(doc, anchor = 0, head = anchor) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  containers.push(container);
  return new EditorView({
    state: EditorState.create({ doc, selection: { anchor, head } }),
    parent: container,
  });
}

describe('toggleBold', () => {
  it('wraps the selection in **', () => {
    const view = makeView('hello', 0, 5);
    toggleBold(view);
    expect(view.state.doc.toString()).toBe('**hello**');
  });

  it('unwraps an already-bold selection', () => {
    const view = makeView('**hello**', 0, 9);
    toggleBold(view);
    expect(view.state.doc.toString()).toBe('hello');
  });

  it('returns false for a null view', () => {
    expect(toggleBold(null)).toBe(false);
  });
});

describe('toggleBullet', () => {
  it('adds a bullet to a plain line', () => {
    const view = makeView('item', 0);
    toggleBullet(view);
    expect(view.state.doc.toString()).toBe('- item');
  });

  it('removes an existing bullet', () => {
    const view = makeView('- item', 0);
    toggleBullet(view);
    expect(view.state.doc.toString()).toBe('item');
  });
});

describe('toggleNumbered', () => {
  it('adds a number to a plain line', () => {
    const view = makeView('item', 0);
    toggleNumbered(view);
    expect(view.state.doc.toString()).toBe('1. item');
  });
});
