import { describe, it, expect, afterEach } from 'vitest';
import { createEditor } from '../core/editor.js';

// jsdom doesn't implement layout, so CodeMirror's async measure (via rAF) calls
// Range.getClientRects(), which is missing and throws as an unhandled error.
// Stub the layout APIs so view creation/measurement is harmless in tests.
const ZERO_RECT = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => [];
  Range.prototype.getBoundingClientRect = () => ZERO_RECT;
}

let containers = [];
afterEach(() => {
  containers.forEach((c) => c.remove());
  containers = [];
});

function makeEditor(doc) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  containers.push(container);
  const view = createEditor(container, doc);
  return view;
}

function pressTab(view, shift = false) {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true }),
  );
}

function pressEnter(view) {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
  );
}

const TABLE = ['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n');

describe('table editor integration (Tab/Enter cell navigation)', () => {
  it('Tab moves the cursor to the next cell inside a table', () => {
    const view = makeEditor(TABLE);
    // Put the cursor on "a" in the header (offset 2).
    view.dispatch({ selection: { anchor: 2 } });
    pressTab(view);
    const pos = view.state.selection.main.head;
    // After reformat, the cursor should sit at the start of cell "b".
    expect(view.state.sliceDoc(pos, pos + 1)).toBe('b');
  });

  it('Tab outside a table still inserts indentation (fallthrough)', () => {
    const view = makeEditor('hello');
    view.dispatch({ selection: { anchor: 0 } });
    pressTab(view);
    // indentWithTab inserts whitespace at the line start.
    expect(view.state.doc.toString()).not.toBe('hello');
  });

  it('Enter moves down a row inside a table', () => {
    const view = makeEditor(TABLE);
    view.dispatch({ selection: { anchor: 2 } }); // on "a"
    pressEnter(view);
    const pos = view.state.selection.main.head;
    expect(view.state.sliceDoc(pos, pos + 1)).toBe('1');
  });

  it('Tab at the last cell appends a new row', () => {
    const view = makeEditor(TABLE);
    const offset = TABLE.indexOf('2');
    view.dispatch({ selection: { anchor: offset } });
    pressTab(view);
    expect(view.state.doc.lines).toBe(4); // header, sep, row, new row
  });
});
