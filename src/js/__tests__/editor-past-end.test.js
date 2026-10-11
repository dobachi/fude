import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { docEndDecorations, pastEndAttrs, scrollPastEnd } from '../core/editor-past-end.js';
import { setScrollPastEndEnabled } from '../core/scroll-past-end.js';

function decoStarts(state) {
  const starts = [];
  const cursor = docEndDecorations(state).iter();
  for (; cursor.value; cursor.next()) starts.push(cursor.from);
  return starts;
}

describe('docEndDecorations', () => {
  it('marks the last line', () => {
    expect(decoStarts(EditorState.create({ doc: 'one\ntwo\nthree' }))).toEqual([8]);
  });

  it('marks the only line of a one-line document', () => {
    expect(decoStarts(EditorState.create({ doc: 'one' }))).toEqual([0]);
  });

  it('marks the empty line after a trailing newline', () => {
    expect(decoStarts(EditorState.create({ doc: 'one\n' }))).toEqual([4]);
  });

  it('marks the single empty line of an empty document', () => {
    expect(decoStarts(EditorState.create({ doc: '' }))).toEqual([0]);
  });
});

describe('pastEndAttrs', () => {
  it('pads the content by the space', () => {
    expect(pastEndAttrs(200)).toEqual({ style: 'padding-bottom: 200px' });
  });

  it('adds nothing without space', () => {
    expect(pastEndAttrs(0)).toBeNull();
    expect(pastEndAttrs(-1)).toBeNull();
  });
});

describe('scrollPastEnd extension', () => {
  let view;
  let size;

  // jsdom lays nothing out, so the scroller's geometry is supplied by hand and
  // the plugin is made to look at it by flipping the setting.
  function mount(doc, geometry = { clientHeight: 400, scrollHeight: 1200 }) {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    view = new EditorView({ parent, doc, extensions: [scrollPastEnd()] });
    size = { ...geometry };
    Object.defineProperty(view.scrollDOM, 'clientHeight', { get: () => size.clientHeight });
    Object.defineProperty(view.scrollDOM, 'scrollHeight', { get: () => size.scrollHeight });
    setScrollPastEndEnabled(false);
    setScrollPastEndEnabled(true);
    return view;
  }

  beforeEach(() => setScrollPastEndEnabled(true));
  afterEach(() => {
    if (view) view.destroy();
    view = null;
    document.body.innerHTML = '';
    setScrollPastEndEnabled(true);
  });

  it('pads the content by half the scroller height', () => {
    mount('one\ntwo');
    expect(view.contentDOM.style.paddingBottom).toBe('200px');
  });

  it('removes the padding when switched off, and puts it back', () => {
    mount('one\ntwo');
    setScrollPastEndEnabled(false);
    expect(view.contentDOM.style.paddingBottom).toBe('');
    setScrollPastEndEnabled(true);
    expect(view.contentDOM.style.paddingBottom).toBe('200px');
  });

  it('keeps the end mark on the last line as the document grows', () => {
    mount('one\ntwo');
    expect(view.contentDOM.querySelector('.cm-doc-end').textContent).toBe('two');

    view.dispatch({ changes: { from: view.state.doc.length, insert: '\nthree' } });
    const marked = view.contentDOM.querySelectorAll('.cm-doc-end');
    expect(marked).toHaveLength(1);
    expect(marked[0].textContent).toBe('three');
  });

  it('flags the scroller only while scrolled into the space', () => {
    mount('one\ntwo');
    const scroller = view.scrollDOM;

    scroller.scrollTop = 600; // 1200 - 400 - 200: the last line at the bottom
    scroller.dispatchEvent(new Event('scroll'));
    expect(scroller.classList.contains('is-past-end')).toBe(false);

    scroller.scrollTop = 650;
    scroller.dispatchEvent(new Event('scroll'));
    expect(scroller.classList.contains('is-past-end')).toBe(true);

    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event('scroll'));
    expect(scroller.classList.contains('is-past-end')).toBe(false);
  });

  it('never flags the scroller when switched off', () => {
    mount('one\ntwo', { clientHeight: 400, scrollHeight: 1000 });
    setScrollPastEndEnabled(false);
    view.scrollDOM.scrollTop = 600;
    view.scrollDOM.dispatchEvent(new Event('scroll'));
    expect(view.scrollDOM.classList.contains('is-past-end')).toBe(false);
  });

  it('stops listening once destroyed', () => {
    mount('one\ntwo');
    const scroller = view.scrollDOM;
    view.destroy();
    view = null;
    scroller.scrollTop = 700;
    scroller.dispatchEvent(new Event('scroll'));
    expect(scroller.classList.contains('is-past-end')).toBe(false);
    // The setting no longer reaches the dead view (it would throw on dispatch).
    expect(() => setScrollPastEndEnabled(false)).not.toThrow();
  });
});
