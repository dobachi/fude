import { describe, it, expect, afterEach } from 'vitest';
import {
  createEditor,
  convertSelectionToTable,
  armPlainPaste,
  takePlainPaste,
} from '../core/editor.js';

// Same layout stubs as table-editor.test.js: jsdom has no layout, and
// CodeMirror's measure pass calls these.
const ZERO_RECT = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => [];
  Range.prototype.getBoundingClientRect = () => ZERO_RECT;
}

let containers = [];
afterEach(() => {
  containers.forEach((c) => c.remove());
  containers = [];
  takePlainPaste(); // never leak an armed plain paste into the next test
});

function makeEditor(doc) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  containers.push(container);
  return createEditor(container, doc);
}

function paste(view, text) {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  event.clipboardData = { getData: (type) => (type === 'text/plain' ? text : ''), items: [] };
  view.contentDOM.dispatchEvent(event);
  return event;
}

describe('paste -> table conversion', () => {
  it('converts pasted TSV into a Markdown table', () => {
    const view = makeEditor('');
    paste(view, 'a\tb\n1\t2');
    expect(view.state.doc.toString()).toBe(
      ['| a   | b   |', '| --- | --- |', '| 1   | 2   |'].join('\n'),
    );
    view.destroy();
  });

  it('leaves comma-separated prose alone', () => {
    const view = makeEditor('');
    const prose =
      'NTT DATA runs dataspace projects all over the world, more than thirty of them.\n' +
      'I am here as a practitioner, not as a standards person.';
    paste(view, prose);
    expect(view.state.doc.toString()).not.toContain('|');
    view.destroy();
  });

  it('skips the conversion when a plain paste is armed (Ctrl+Shift+V)', () => {
    const view = makeEditor('');
    armPlainPaste();
    paste(view, 'a\tb\n1\t2');
    expect(view.state.doc.toString()).not.toContain('|');
    view.destroy();
  });
});

describe('plain paste flag', () => {
  it('is one-shot', () => {
    armPlainPaste(1000);
    expect(takePlainPaste(1100)).toBe(true);
    expect(takePlainPaste(1100)).toBe(false);
  });

  it('expires so a swallowed shortcut cannot disarm the next paste', () => {
    armPlainPaste(1000);
    expect(takePlainPaste(9000)).toBe(false);
  });
});

describe('convertSelectionToTable', () => {
  it('converts the selected lines into an aligned table', () => {
    const view = makeEditor('x,y\n1,2');
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    expect(convertSelectionToTable(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(
      ['| x   | y   |', '| --- | --- |', '| 1   | 2   |'].join('\n'),
    );
    view.destroy();
  });

  it('keeps the table on its own lines when the selection is mid-paragraph', () => {
    const view = makeEditor('intro a,b end');
    view.dispatch({ selection: { anchor: 6, head: 9 } }); // "a,b"
    expect(convertSelectionToTable(view)).toBe(true);
    const lines = view.state.doc.toString().split('\n');
    expect(lines[0]).toBe('intro ');
    expect(lines[1]).toBe('| a   | b   |');
    expect(lines[lines.length - 1]).toBe(' end');
    view.destroy();
  });

  it('returns false without a selection', () => {
    const view = makeEditor('hello');
    view.dispatch({ selection: { anchor: 0 } });
    expect(convertSelectionToTable(view)).toBe(false);
    expect(view.state.doc.toString()).toBe('hello');
    view.destroy();
  });

  it('returns false for a blank selection', () => {
    const view = makeEditor('   ');
    view.dispatch({ selection: { anchor: 0, head: 3 } });
    expect(convertSelectionToTable(view)).toBe(false);
    view.destroy();
  });
});
