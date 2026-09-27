import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import markdownIt from 'markdown-it';
import {
  blockLineRange,
  guessCursor,
  topLevelBlockOf,
  isInsideInlineEditor,
  startInlineEdit,
  commitInlineEdit,
  cancelInlineEdit,
  isInlineEditing,
  INLINE_EDITOR_CLASS,
} from '../core/preview-edit.js';
import { renderMarkdown, initPreview, previewBlockRange } from '../core/preview.js';
import { createInlineEditor } from '../core/editor.js';

const md = markdownIt();

/** Lines from..to (1-based, inclusive) of `text`. */
function slice(text, range) {
  return text
    .split('\n')
    .slice(range.from - 1, range.to)
    .join('\n');
}

describe('blockLineRange', () => {
  const doc = [
    '# Title', // 1
    '', // 2
    'para one', // 3
    'continues', // 4
    '', // 5
    '- a', // 6
    '- b', // 7
    '  - nested', // 8
    '', // 9
    '```js', // 10
    'code()', // 11
    '```', // 12
    '', // 13
    '| h |', // 14
    '|---|', // 15
    '| c |', // 16
    '', // 17
    '> quote', // 18
    '> more', // 19
  ].join('\n');

  it('finds a single-line heading', () => {
    expect(blockLineRange(md, doc, 1)).toEqual({ from: 1, to: 1 });
  });

  it('covers every line of a multi-line paragraph', () => {
    const r = blockLineRange(md, doc, 3);
    expect(slice(doc, r)).toBe('para one\ncontinues');
  });

  it('covers a whole list including nested items', () => {
    const r = blockLineRange(md, doc, 6);
    expect(slice(doc, r)).toBe('- a\n- b\n  - nested');
  });

  it('covers a fence including both markers', () => {
    const r = blockLineRange(md, doc, 10);
    expect(slice(doc, r)).toBe('```js\ncode()\n```');
  });

  it('covers a table and a blockquote', () => {
    expect(slice(doc, blockLineRange(md, doc, 14))).toBe('| h |\n|---|\n| c |');
    expect(slice(doc, blockLineRange(md, doc, 18))).toBe('> quote\n> more');
  });

  it('returns null for a line where no top-level block starts', () => {
    expect(blockLineRange(md, doc, 4)).toBeNull(); // inside a paragraph
    expect(blockLineRange(md, doc, 7)).toBeNull(); // a list item, not the list
    expect(blockLineRange(md, doc, 2)).toBeNull(); // blank
    expect(blockLineRange(md, doc, 99)).toBeNull();
  });

  it('handles an empty document', () => {
    expect(blockLineRange(md, '', 1)).toBeNull();
  });
});

describe('previewBlockRange', () => {
  it('parses Markdown files block by block', () => {
    expect(previewBlockRange('a\n\nb\nc\n', 3, 'x.md')).toEqual({ from: 3, to: 4 });
  });

  it('uses the Quarto parser for .qmd, so front matter is not a paragraph', () => {
    const text = '---\ntitle: T\n---\n\nbody\n';
    expect(previewBlockRange(text, 5, 'doc.qmd')).toEqual({ from: 5, to: 5 });
  });
});

describe('guessCursor', () => {
  it('lands on the double-clicked word', () => {
    expect(guessCursor('Hello **brave** world', 'brave')).toBe(8);
  });

  it('falls back to the start when the word is missing or not found', () => {
    expect(guessCursor('abc', '')).toBe(0);
    expect(guessCursor('abc', 'zzz')).toBe(0);
    expect(guessCursor('abc', undefined)).toBe(0);
  });

  it('ignores surrounding whitespace in the selection', () => {
    expect(guessCursor('one two', ' two ')).toBe(4);
  });
});

describe('topLevelBlockOf / isInsideInlineEditor', () => {
  it('walks up to the direct child of the container', () => {
    const c = document.createElement('div');
    c.innerHTML = '<ul><li><strong>x</strong></li></ul><p>y</p>';
    expect(topLevelBlockOf(c, c.querySelector('strong'))).toBe(c.querySelector('ul'));
    expect(topLevelBlockOf(c, c.querySelector('p').firstChild)).toBe(c.querySelector('p'));
    expect(topLevelBlockOf(c, c)).toBeNull();
    expect(topLevelBlockOf(c, document.body)).toBeNull();
    expect(topLevelBlockOf(c, null)).toBeNull();
  });

  it('recognises nodes inside an inline editor', () => {
    const host = document.createElement('div');
    host.className = INLINE_EDITOR_CLASS;
    const inner = document.createElement('span');
    host.appendChild(inner);
    expect(isInsideInlineEditor(inner)).toBe(true);
    expect(isInsideInlineEditor(document.createElement('span'))).toBe(false);
    expect(isInsideInlineEditor(null)).toBe(false);
  });
});

/** A stand-in for CodeMirror: a textarea with the view surface we use. */
function fakeMount(host, text, handlers, cursor) {
  const ta = document.createElement('textarea');
  ta.value = text;
  host.appendChild(ta);
  fakeMount.last = { ta, handlers, cursor };
  return {
    state: {
      doc: {
        toString: () => ta.value,
      },
    },
    destroy: vi.fn(() => ta.remove()),
    focus: () => ta.focus(),
  };
}

describe('startInlineEdit', () => {
  let container;

  beforeEach(() => {
    container = document.createElement('div');
    container.tabIndex = 0;
    container.innerHTML = '<h1 data-source-line="1">T</h1><p data-source-line="3">body</p>';
    document.body.appendChild(container);
  });

  afterEach(() => {
    cancelInlineEdit();
    container.remove();
  });

  function open(extra = {}) {
    const blockEl = container.querySelector('p');
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    startInlineEdit({
      container,
      blockEl,
      text: 'body',
      cursor: 2,
      mountEditor: fakeMount,
      onCommit,
      onCancel,
      ...extra,
    });
    return { blockEl, onCommit, onCancel };
  }

  it('swaps the block for an editor host one-for-one, keeping the source line', () => {
    const before = container.childNodes.length;
    const { blockEl } = open();
    const host = container.querySelector(`.${INLINE_EDITOR_CLASS}`);
    expect(host).not.toBeNull();
    expect(host.getAttribute('data-source-line')).toBe('3');
    expect(blockEl.isConnected).toBe(false);
    expect(container.childNodes.length).toBe(before);
    expect(fakeMount.last.ta.value).toBe('body');
    expect(fakeMount.last.cursor).toBe(2);
    expect(isInlineEditing(container)).toBe(true);
  });

  it('commit restores the block and hands over the edited text', () => {
    const { blockEl, onCommit } = open();
    fakeMount.last.ta.value = 'edited';
    fakeMount.last.handlers.commit();
    expect(onCommit).toHaveBeenCalledWith('edited');
    expect(blockEl.isConnected).toBe(true);
    expect(container.querySelector(`.${INLINE_EDITOR_CLASS}`)).toBeNull();
    expect(isInlineEditing()).toBe(false);
  });

  it('commit from the editor returns focus to the preview', () => {
    open();
    fakeMount.last.handlers.commit();
    expect(document.activeElement).toBe(container);
  });

  it('cancel restores the block and reports the text to onCancel only', () => {
    const { blockEl, onCommit, onCancel } = open();
    fakeMount.last.ta.value = 'draft';
    cancelInlineEdit();
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledWith('draft');
    expect(blockEl.isConnected).toBe(true);
  });

  it('finishes only once', () => {
    const { onCommit } = open();
    const { commit } = fakeMount.last.handlers;
    commit();
    commit();
    commitInlineEdit();
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('opening a second edit commits the first', () => {
    const first = open();
    const h1 = container.querySelector('h1');
    const second = vi.fn();
    startInlineEdit({
      container,
      blockEl: h1,
      text: '# T',
      mountEditor: fakeMount,
      onCommit: second,
    });
    expect(first.onCommit).toHaveBeenCalledWith('body');
    expect(first.blockEl.isConnected).toBe(true);
    expect(h1.isConnected).toBe(false);
    commitInlineEdit();
    expect(second).toHaveBeenCalledWith('# T');
  });

  it('focus leaving the editor commits', () => {
    const { onCommit } = open();
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    fakeMount.last.ta.focus();
    outside.focus();
    expect(onCommit).toHaveBeenCalledWith('body');
    outside.remove();
  });

  it('focus moving within the editor does not commit', () => {
    const { onCommit } = open();
    const host = container.querySelector(`.${INLINE_EDITOR_CLASS}`);
    const other = document.createElement('input');
    host.appendChild(other);
    fakeMount.last.ta.focus();
    other.focus();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('still reports the text when the host was dropped by a re-render', () => {
    const { onCommit } = open();
    fakeMount.last.ta.value = 'kept';
    container.innerHTML = '<p>rebuilt</p>';
    commitInlineEdit();
    expect(onCommit).toHaveBeenCalledWith('kept');
    expect(container.innerHTML).toBe('<p>rebuilt</p>');
  });
});

describe('preview double-click', () => {
  let container;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    cancelInlineEdit();
    container.remove();
  });

  function dblclick(el) {
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  }

  it('asks to edit the top-level block under the pointer', () => {
    const onBlockEdit = vi.fn();
    initPreview(container, { onBlockEdit });
    renderMarkdown('# T\n\n- a\n- **b**\n', '', container);
    dblclick(container.querySelector('strong'));
    expect(onBlockEdit).toHaveBeenCalledTimes(1);
    const req = onBlockEdit.mock.calls[0][0];
    expect(req.line).toBe(3); // the list, not the item on line 4
    expect(req.blockEl).toBe(container.querySelector('ul'));
    expect(req.container).toBe(container);
  });

  it('ignores links and checkboxes, which acted on the first click', () => {
    const onBlockEdit = vi.fn();
    initPreview(container, { onBlockEdit });
    renderMarkdown('[l](#x)\n\n- [ ] t\n', '', container);
    dblclick(container.querySelector('a'));
    dblclick(container.querySelector('input'));
    expect(onBlockEdit).not.toHaveBeenCalled();
  });

  it('ignores double-clicks inside an open inline editor', () => {
    const onBlockEdit = vi.fn();
    initPreview(container, { onBlockEdit });
    renderMarkdown('para\n', '', container);
    startInlineEdit({
      container,
      blockEl: container.querySelector('p'),
      text: 'para',
      mountEditor: fakeMount,
      onCommit: () => {},
    });
    dblclick(fakeMount.last.ta);
    expect(onBlockEdit).not.toHaveBeenCalled();
  });

  it('does not treat keys typed into the inline editor as preview navigation', () => {
    initPreview(container, {});
    renderMarkdown('para\n', '', container);
    startInlineEdit({
      container,
      blockEl: container.querySelector('p'),
      text: 'para',
      mountEditor: fakeMount,
      onCommit: () => {},
    });
    const ev = new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true });
    fakeMount.last.ta.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });
});

describe('createInlineEditor', () => {
  let parent;

  beforeEach(() => {
    parent = document.createElement('div');
    document.body.appendChild(parent);
  });

  afterEach(() => parent.remove());

  it('holds the block text with the caret at the requested offset', () => {
    const view = createInlineEditor(parent, 'hello world', { commit: () => {} }, 6);
    expect(view.state.doc.toString()).toBe('hello world');
    expect(view.state.selection.main.head).toBe(6);
    expect(view._keymodeCompartment).toBeTruthy();
    view.destroy();
  });

  it('clamps an out-of-range caret', () => {
    const view = createInlineEditor(parent, 'abc', { commit: () => {} }, 99);
    expect(view.state.selection.main.head).toBe(3);
    view.destroy();
  });

  it('Escape and Ctrl+Enter finish the edit', () => {
    const commit = vi.fn();
    const view = createInlineEditor(parent, 'x', { commit });
    const key = (init) =>
      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
      );
    key({ key: 'Escape' });
    key({ key: 'Enter', ctrlKey: true });
    expect(commit).toHaveBeenCalledTimes(2);
    view.destroy();
  });
});
