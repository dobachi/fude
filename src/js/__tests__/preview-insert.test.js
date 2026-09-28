import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  insertBlockChange,
  nearestGap,
  resolveGap,
  gapAfterLine,
  clampButtonY,
  attachInsertButton,
  INSERT_BUTTON_CLASS,
} from '../core/preview-insert.js';
import {
  startInlineEdit,
  commitInlineEdit,
  cancelInlineEdit,
  isInlineEditing,
  INLINE_EDITOR_CLASS,
  INSERT_HOLDER_CLASS,
} from '../core/preview-edit.js';
import { renderMarkdown, renderPreview, initPreview, previewBlockRange } from '../core/preview.js';

/** `text` with `change` applied. */
function applied(text, change) {
  return text.slice(0, change.from) + change.insert + text.slice(change.from);
}

const insert = (text, afterLine, newText) =>
  applied(text, insertBlockChange(text, afterLine, newText));

describe('insertBlockChange', () => {
  it('adds a block after a line, set off by blank lines', () => {
    expect(insert('a\n\nb\n', 1, 'new')).toBe('a\n\nnew\n\nb\n');
  });

  it('adds the blank line after it when the next block follows directly', () => {
    expect(insert('a\n# h\n', 1, 'new')).toBe('a\n\nnew\n\n# h\n');
  });

  it('appends at the end, with and without a final newline', () => {
    expect(insert('a\n', 1, 'new')).toBe('a\n\nnew\n');
    expect(insert('a', 1, 'new')).toBe('a\n\nnew');
  });

  it('skips blank lines above the insertion point instead of widening the gap', () => {
    expect(insert('a\n\nb\n', 2, 'new')).toBe('a\n\nnew\n\nb\n');
    expect(insert('a\n\n\n\nb', 4, 'new')).toBe('a\n\nnew\n\n\n\nb');
  });

  it('inserts at the top', () => {
    expect(insert('a\n', 0, 'new')).toBe('new\n\na\n');
    expect(insert('\n\na', 2, 'new')).toBe('new\n\n\na');
  });

  it('writes the first line of an empty document', () => {
    expect(insert('', 0, 'new')).toBe('new\n');
    expect(insert('', 1, 'new')).toBe('new\n');
    expect(insert('\n', 2, 'new')).toBe('new\n\n');
  });

  it('clamps a line past the end, and treats junk as the top', () => {
    expect(insert('a\nb', 99, 'new')).toBe('a\nb\n\nnew');
    expect(insert('a', -3, 'new')).toBe('new\n\na');
    expect(insert('a', NaN, 'new')).toBe('new\n\na');
    expect(insert('a', undefined, 'new')).toBe('new\n\na');
  });

  it('keeps several lines, trimming only the blank edges', () => {
    expect(insert('a', 1, '\n\n- x\n- y\n\n')).toBe('a\n\n- x\n- y');
    expect(insert('a', 1, '    code')).toBe('a\n\n    code');
  });

  it('is null when there is nothing to insert', () => {
    expect(insertBlockChange('a', 1, '')).toBeNull();
    expect(insertBlockChange('a', 1, '  \n\t\n')).toBeNull();
    expect(insertBlockChange('a', 1, null)).toBeNull();
    expect(insertBlockChange('a', 1, undefined)).toBeNull();
  });

  it('keeps multi-byte text and offsets intact', () => {
    expect(insert('日本語\n\n次\n', 1, '追記')).toBe('日本語\n\n追記\n\n次\n');
  });

  describe('rendered result', () => {
    function render(src) {
      const c = document.createElement('div');
      renderMarkdown(src, '', c);
      return c;
    }

    it('text after a table is a paragraph, not another row', () => {
      const src = '| a | b |\n|---|---|\n| c | d |\n';
      const c = render(insert(src, 3, 'after'));
      expect(c.querySelectorAll('tr')).toHaveLength(2);
      expect(c.lastElementChild.tagName).toBe('P');
      expect(c.lastElementChild.textContent).toBe('after');
    });

    it('text between a table and what follows it directly stays separate', () => {
      const src = '| a |\n|---|\n| c |\n# next\n';
      const c = render(insert(src, 3, 'between'));
      expect(Array.from(c.children, (el) => el.tagName)).toEqual(['TABLE', 'P', 'H1']);
      expect(c.children[1].textContent).toBe('between');
    });

    it('text after a paragraph does not join it', () => {
      const c = render(insert('one\ntwo\n', 2, 'three'));
      expect(Array.from(c.children, (el) => el.textContent)).toEqual(['one\ntwo', 'three']);
    });

    it('text after a code fence is not joined by the line that follows', () => {
      const c = render(insert('```\nx\n```\ntail\n', 3, 'mid'));
      expect(Array.from(c.children, (el) => el.tagName)).toEqual(['PRE', 'P', 'P']);
      expect(c.children[1].textContent).toBe('mid');
    });
  });
});

describe('nearestGap', () => {
  // Three blocks: 0-10, 20-40, 50-60.
  const rects = [
    { top: 0, bottom: 10 },
    { top: 20, bottom: 40 },
    { top: 50, bottom: 60 },
  ];
  const at = (y) => nearestGap(rects.length, (i) => rects[i], y);

  it('is null without blocks', () => {
    expect(nearestGap(0, () => ({ top: 0, bottom: 0 }), 5)).toBeNull();
    expect(nearestGap(-1, () => ({ top: 0, bottom: 0 }), 5)).toBeNull();
  });

  it('picks the boundary above in the upper half of a block', () => {
    expect(at(2)).toEqual({ index: 0, y: 0 });
    expect(at(25)).toEqual({ index: 1, y: 15 });
  });

  it('picks the boundary below in the lower half', () => {
    expect(at(8)).toEqual({ index: 1, y: 15 });
    expect(at(35)).toEqual({ index: 2, y: 45 });
    expect(at(58)).toEqual({ index: 3, y: 60 });
  });

  it('picks the boundary the pointer is on, between blocks', () => {
    expect(at(15)).toEqual({ index: 1, y: 15 });
    expect(at(45)).toEqual({ index: 2, y: 45 });
  });

  it('clamps above the first and below the last block', () => {
    expect(at(-100)).toEqual({ index: 0, y: 0 });
    expect(at(1000)).toEqual({ index: 3, y: 60 });
  });

  it('handles a single block', () => {
    const one = (y) => nearestGap(1, () => ({ top: 10, bottom: 30 }), y);
    expect(one(12)).toEqual({ index: 0, y: 10 });
    expect(one(28)).toEqual({ index: 1, y: 30 });
  });

  it('reads only a few blocks of a long document', () => {
    const rectAt = vi.fn((i) => ({ top: i * 10, bottom: i * 10 + 8 }));
    expect(nearestGap(10000, rectAt, 50003)).toEqual({ index: 5000, y: 49999 });
    expect(rectAt.mock.calls.length).toBeLessThan(30);
  });
});

describe('resolveGap', () => {
  let container;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => container.remove());

  it('goes after the block above', () => {
    renderMarkdown('one\n\ntwo\n', '', container);
    const [one, two] = container.children;
    expect(resolveGap(container, one, two)).toEqual({ el: one, where: 'after', line: 1 });
    expect(resolveGap(container, two, null)).toEqual({ el: two, where: 'after', line: 3 });
  });

  it('goes before the first block at the top', () => {
    renderMarkdown('one\n', '', container);
    const one = container.firstElementChild;
    expect(resolveGap(container, null, one)).toEqual({ el: one, where: 'before', line: 1 });
  });

  it('falls back to the block below when the one above has no source line', () => {
    container.innerHTML = '<header>t</header><p data-source-line="5">x</p>';
    const [header, p] = container.children;
    expect(resolveGap(container, header, p)).toEqual({ el: p, where: 'before', line: 5 });
  });

  it('falls back to the block below when the one above was re-rendered away', () => {
    renderMarkdown('one\n\ntwo\n', '', container);
    const [one, two] = container.children;
    one.remove();
    expect(resolveGap(container, one, two)).toEqual({ el: two, where: 'before', line: 3 });
  });

  it('is the end of the document when nothing is below', () => {
    container.innerHTML = '<header>t</header>';
    const header = container.firstElementChild;
    expect(resolveGap(container, header, null)).toEqual({
      el: header,
      where: 'after',
      line: null,
    });
  });

  it('is the end of an empty document', () => {
    expect(resolveGap(container, null, null)).toEqual({ el: null, where: 'after', line: null });
  });

  it('is null when a boundary inside the document cannot be placed', () => {
    container.innerHTML = '<header>t</header><div>raw</div>';
    const [header, raw] = container.children;
    expect(resolveGap(container, null, header)).toBeNull();
    expect(resolveGap(container, header, raw)).toBeNull();
  });

  it('does not take a nested element for a block', () => {
    renderMarkdown('- a\n- b\n', '', container);
    const li = container.querySelector('li');
    expect(resolveGap(container, li, null)).toEqual({
      el: container.lastElementChild,
      where: 'after',
      line: null,
    });
  });
});

describe('gapAfterLine', () => {
  const range = (line) => ({ from: line, to: line + 2 });

  it('is the end of the block above', () => {
    expect(gapAfterLine({ where: 'after', line: 4 }, 20, range)).toBe(6);
  });

  it('is the line above the block below', () => {
    expect(gapAfterLine({ where: 'before', line: 4 }, 20, range)).toBe(3);
    expect(gapAfterLine({ where: 'before', line: 1 }, 20, range)).toBe(0);
  });

  it('is the last line at the end of the document', () => {
    expect(gapAfterLine({ where: 'after', line: null }, 20, range)).toBe(20);
  });

  it('is null when the block is not in the source', () => {
    expect(gapAfterLine({ where: 'after', line: 4 }, 20, () => null)).toBeNull();
  });
});

// The whole path a click takes, minus the editor: boundary → line → change.
describe('inserting at a boundary of a rendered document', () => {
  let container;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => container.remove());

  function insertAt(src, index, newText, filePath = 'a.md') {
    renderPreview(src, '', container, filePath);
    const blocks = container.children;
    const gap = resolveGap(container, blocks[index - 1] || null, blocks[index] || null);
    const afterLine = gapAfterLine(gap, src.split('\n').length, (line) =>
      previewBlockRange(src, line, filePath),
    );
    return applied(src, insertBlockChange(src, afterLine, newText));
  }

  const doc = '# T\n\n| a | b |\n|---|---|\n| c | d |\n\n- x\n- y\n';

  it('after a table', () => {
    expect(insertAt(doc, 2, 'new')).toBe(
      '# T\n\n| a | b |\n|---|---|\n| c | d |\n\nnew\n\n- x\n- y\n',
    );
  });

  it('after a table that ends the document', () => {
    const src = '| a |\n|---|\n| c |';
    expect(insertAt(src, 1, 'new')).toBe('| a |\n|---|\n| c |\n\nnew');
  });

  it('after a list, not inside it', () => {
    const out = insertAt(doc, 3, 'new');
    expect(out).toBe('# T\n\n| a | b |\n|---|---|\n| c | d |\n\n- x\n- y\n\nnew\n');
    renderMarkdown(out, '', container);
    expect(container.lastElementChild.tagName).toBe('P');
    expect(container.querySelectorAll('li')).toHaveLength(2);
  });

  it('above the first block', () => {
    expect(insertAt(doc, 0, 'new')).toBe(`new\n\n${doc}`);
  });

  it('into an empty document', () => {
    expect(insertAt('', 0, 'new')).toBe('new\n');
  });

  it('under a Quarto title block, below the front matter', () => {
    const src = '---\ntitle: T\n---\n\nbody\n';
    renderPreview(src, '', container, 'a.qmd');
    expect(container.firstElementChild.tagName).toBe('HEADER');
    expect(insertAt(src, 1, 'new', 'a.qmd')).toBe('---\ntitle: T\n---\n\nnew\n\nbody\n');
  });

  it('at the end of a Quarto document that is only front matter', () => {
    const src = '---\ntitle: T\n---\n';
    expect(insertAt(src, 1, 'new', 'a.qmd')).toBe('---\ntitle: T\n---\n\nnew\n');
  });
});

describe('clampButtonY', () => {
  it('leaves a boundary inside the preview where it is', () => {
    expect(clampButtonY(200, 100, 400)).toBe(200);
  });

  it('keeps the whole button inside at either edge', () => {
    expect(clampButtonY(100, 100, 400)).toBe(110);
    expect(clampButtonY(400, 100, 400)).toBe(390);
    expect(clampButtonY(395, 100, 400)).toBe(390);
  });

  it('centres in a preview shorter than the button', () => {
    expect(clampButtonY(100, 100, 112)).toBe(106);
  });
});

describe('attachInsertButton', () => {
  let pane;
  let container;
  let onInsert;

  // The container spans x 100-500, y 0-400, with a 32px margin on the left;
  // its blocks are 40px tall with 20px between them, starting at y 20.
  function layout() {
    container.getBoundingClientRect = () => ({ left: 100, right: 500, top: 0, bottom: 400 });
    Array.from(container.children).forEach((el, i) => {
      const top = 20 + i * 60;
      el.getBoundingClientRect = () => ({ left: 132, right: 468, top, bottom: top + 40 });
    });
  }

  function move(x, y) {
    container.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
  }

  const button = () => pane.querySelector(`.${INSERT_BUTTON_CLASS}`);
  const shown = () => !!button() && !button().hidden;

  beforeEach(() => {
    pane = document.createElement('div');
    container = document.createElement('div');
    pane.appendChild(container);
    document.body.appendChild(pane);
    onInsert = vi.fn();
    attachInsertButton(container, onInsert);
    renderMarkdown('one\n\n| a |\n|---|\n| c |\n\nthree\n', '', container);
    layout();
  });

  afterEach(() => {
    cancelInlineEdit();
    pane.remove();
  });

  it('stays out of the container, whose children are the blocks', () => {
    const before = container.childNodes.length;
    move(110, 30);
    expect(shown()).toBe(true);
    expect(container.childNodes.length).toBe(before);
    expect(button().parentElement).toBe(pane);
  });

  it('shows at the nearest boundary while the pointer is in the left margin', () => {
    move(110, 115); // lower half of the table (80-120) → boundary at 130
    expect(shown()).toBe(true);
    expect(button().style.top).toBe('130px');
    expect(button().style.left).toBe('116px'); // middle of the margin
  });

  it('hides once the pointer is over the text', () => {
    move(110, 30);
    move(200, 30);
    expect(shown()).toBe(false);
  });

  it('hides when the pointer leaves the preview, but not onto the button', () => {
    move(110, 30);
    container.dispatchEvent(new MouseEvent('mouseleave', { relatedTarget: button() }));
    expect(shown()).toBe(true);
    container.dispatchEvent(new MouseEvent('mouseleave', { relatedTarget: document.body }));
    expect(shown()).toBe(false);
  });

  it('hides when the pointer leaves the button away from the preview', () => {
    move(110, 30);
    button().dispatchEvent(new MouseEvent('mouseleave', { relatedTarget: document.body }));
    expect(shown()).toBe(false);
  });

  it('hides on scroll', () => {
    move(110, 30);
    container.dispatchEvent(new Event('scroll'));
    expect(shown()).toBe(false);
  });

  it('hides when the boundary is scrolled out of view', () => {
    container.getBoundingClientRect = () => ({ left: 100, right: 500, top: 30, bottom: 400 });
    move(110, 35); // nearest boundary is at y 20, above the visible part
    expect(shown()).toBe(false);
  });

  it('stays inside the preview for a boundary at its edge', () => {
    // A short pane (the upper one of a top/bottom split) ending right where
    // the table does: the boundary under the table is at the pane's edge.
    container.getBoundingClientRect = () => ({ left: 100, right: 500, top: 0, bottom: 130 });
    move(110, 115);
    expect(shown()).toBe(true);
    expect(button().style.top).toBe('120px');
    button().click();
    expect(onInsert.mock.calls[0][0].prevEl).toBe(container.querySelector('table'));
  });

  it('asks to insert after the table', () => {
    move(110, 115);
    button().click();
    expect(onInsert).toHaveBeenCalledTimes(1);
    const req = onInsert.mock.calls[0][0];
    expect(req.container).toBe(container);
    expect(req.prevEl).toBe(container.querySelector('table'));
    expect(req.nextEl).toBe(container.children[2]);
    expect(shown()).toBe(false);
  });

  it('asks to insert at the top and at the end', () => {
    move(110, 22);
    button().click();
    expect(onInsert.mock.calls[0][0]).toMatchObject({
      prevEl: null,
      nextEl: container.children[0],
    });
    move(110, 390);
    button().click();
    expect(onInsert.mock.calls[1][0]).toMatchObject({
      prevEl: container.children[2],
      nextEl: null,
    });
  });

  it('offers the first line of an empty document', () => {
    renderMarkdown('', '', container);
    expect(container.children).toHaveLength(0);
    move(110, 100);
    expect(shown()).toBe(true);
    button().click();
    expect(onInsert.mock.calls[0][0]).toMatchObject({ prevEl: null, nextEl: null });
  });

  it('does not take the focus on mousedown, so an open edit is not cut short', () => {
    move(110, 30);
    const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    button().dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('is kept out of the tab order and labelled', () => {
    move(110, 30);
    expect(button().tabIndex).toBe(-1);
    expect(button().getAttribute('aria-label')).toBeTruthy();
    expect(button().type).toBe('button');
  });

  it('does nothing for a whole-file diagram', () => {
    container.dataset.wholeFile = 'true';
    move(110, 30);
    expect(shown()).toBe(false);
  });

  it('does not show where the boundary cannot be tied to the source', () => {
    container.innerHTML = '<header>t</header><div>raw</div>';
    layout();
    move(110, 22);
    expect(shown()).toBe(false);
  });

  it('gives each preview its own button', () => {
    const pane2 = document.createElement('div');
    const container2 = document.createElement('div');
    pane2.appendChild(container2);
    document.body.appendChild(pane2);
    const onInsert2 = vi.fn();
    attachInsertButton(container2, onInsert2);
    renderMarkdown('other\n', '', container2);
    container2.getBoundingClientRect = () => ({ left: 600, right: 900, top: 0, bottom: 400 });
    container2.firstElementChild.getBoundingClientRect = () => ({ top: 20, bottom: 60 });

    move(110, 30);
    container2.dispatchEvent(
      new MouseEvent('mousemove', { clientX: 610, clientY: 55, bubbles: true }),
    );
    const b2 = pane2.querySelector(`.${INSERT_BUTTON_CLASS}`);
    expect(shown()).toBe(true);
    expect(b2.hidden).toBe(false);
    expect(b2.style.left).toBe('616px');

    b2.click();
    expect(onInsert2).toHaveBeenCalledTimes(1);
    expect(onInsert2.mock.calls[0][0].container).toBe(container2);
    expect(onInsert).not.toHaveBeenCalled();
    expect(shown()).toBe(true); // the other pane's button is untouched
    pane2.remove();
  });

  it('goes away with its pane', () => {
    move(110, 30);
    const b = button();
    pane.remove();
    expect(b.isConnected).toBe(false);
  });

  it('is wired up by initPreview, and marked off for whole-file diagrams', () => {
    const c = document.createElement('div');
    pane.appendChild(c);
    const cb = vi.fn();
    initPreview(c, { onBlockInsert: cb });
    renderPreview('x\n', '', c, 'a.md');
    expect(c.dataset.wholeFile).toBeUndefined();
    c.getBoundingClientRect = () => ({ left: 0, right: 300, top: 0, bottom: 400 });
    c.firstElementChild.getBoundingClientRect = () => ({ top: 20, bottom: 60 });
    c.dispatchEvent(new MouseEvent('mousemove', { clientX: 5, clientY: 55, bubbles: true }));
    const buttons = pane.querySelectorAll(`.${INSERT_BUTTON_CLASS}`);
    buttons[buttons.length - 1].click();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('is not added when the preview has no insert handler', () => {
    const c = document.createElement('div');
    pane.appendChild(c);
    initPreview(c, {});
    renderMarkdown('x\n', '', c);
    c.getBoundingClientRect = () => ({ left: 0, right: 300, top: 0, bottom: 400 });
    c.dispatchEvent(new MouseEvent('mousemove', { clientX: 5, clientY: 55, bubbles: true }));
    expect(pane.querySelectorAll(`.${INSERT_BUTTON_CLASS}`)).toHaveLength(0);
  });
});

describe('startInlineEdit insert', () => {
  let container;

  function fakeMount(host, text, handlers) {
    const ta = document.createElement('textarea');
    ta.value = text;
    host.appendChild(ta);
    fakeMount.last = { ta, handlers };
    return { state: { doc: { toString: () => ta.value } }, destroy: () => ta.remove() };
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    renderMarkdown('| a |\n|---|\n| c |\n\ntail\n', '', container);
  });

  afterEach(() => {
    cancelInlineEdit();
    container.remove();
  });

  function open(insert, blockEl = container.querySelector('table'), extra = {}) {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    startInlineEdit({
      container,
      blockEl,
      insert,
      text: '',
      mountEditor: fakeMount,
      onCommit,
      onCancel,
      ...extra,
    });
    return { onCommit, onCancel };
  }

  it('opens under the block, which stays on screen', () => {
    const table = container.querySelector('table');
    const nodes = container.childNodes.length;
    open('after');
    const holder = container.querySelector(`.${INSERT_HOLDER_CLASS}`);
    expect(holder.parentElement).toBe(container);
    expect(Array.from(holder.children)).toEqual([
      table,
      holder.querySelector(`.${INLINE_EDITOR_CLASS}`),
    ]);
    expect(table.isConnected).toBe(true);
    // One element for one: preview-blocks finds blocks by counting nodes.
    expect(container.childNodes.length).toBe(nodes);
    expect(isInlineEditing(container)).toBe(true);
  });

  it('opens above the block for an insert before it', () => {
    const table = container.querySelector('table');
    open('before');
    const holder = container.querySelector(`.${INSERT_HOLDER_CLASS}`);
    expect(holder.firstElementChild.classList.contains(INLINE_EDITOR_CLASS)).toBe(true);
    expect(holder.lastElementChild).toBe(table);
  });

  it('adds no second carrier of the source line', () => {
    const count = () => container.querySelectorAll('[data-source-line]').length;
    const before = count();
    open('after');
    expect(count()).toBe(before);
  });

  it('puts the block back and reports the text on commit', () => {
    const table = container.querySelector('table');
    const html = container.innerHTML;
    const { onCommit } = open('after');
    fakeMount.last.ta.value = 'new line';
    fakeMount.last.handlers.commit();
    expect(onCommit).toHaveBeenCalledWith('new line');
    expect(container.innerHTML).toBe(html);
    expect(table.parentElement).toBe(container);
    expect(isInlineEditing()).toBe(false);
  });

  it('puts the block back and keeps the text on cancel', () => {
    const html = container.innerHTML;
    const { onCommit, onCancel } = open('after');
    fakeMount.last.ta.value = 'draft';
    cancelInlineEdit();
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledWith('draft');
    expect(container.innerHTML).toBe(html);
  });

  it('commits when the focus leaves the editor', () => {
    const { onCommit } = open('after');
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    fakeMount.last.ta.value = 'x';
    fakeMount.last.ta.focus();
    outside.focus();
    expect(onCommit).toHaveBeenCalledWith('x');
    outside.remove();
  });

  it('opens in a preview that has no blocks, and leaves it empty again', () => {
    renderMarkdown('', '', container);
    const { onCommit } = open('after', null);
    expect(container.children).toHaveLength(1);
    expect(container.firstElementChild.classList.contains(INLINE_EDITOR_CLASS)).toBe(true);
    fakeMount.last.ta.value = 'first';
    commitInlineEdit();
    expect(onCommit).toHaveBeenCalledWith('first');
    expect(container.children).toHaveLength(0);
  });

  it('opening an insert commits the edit that was open', () => {
    const first = vi.fn();
    const tail = container.querySelector('p');
    startInlineEdit({
      container,
      blockEl: tail,
      text: 'tail',
      mountEditor: fakeMount,
      onCommit: first,
    });
    open('after');
    expect(first).toHaveBeenCalledWith('tail');
    expect(tail.parentElement).toBe(container);
  });

  it('still reports the text when a re-render dropped the holder', () => {
    const { onCommit } = open('after');
    fakeMount.last.ta.value = 'kept';
    container.innerHTML = '<p>rebuilt</p>';
    commitInlineEdit();
    expect(onCommit).toHaveBeenCalledWith('kept');
    expect(container.innerHTML).toBe('<p>rebuilt</p>');
  });

  it('survives a re-render of the blocks around it', () => {
    const { onCommit } = open('after');
    fakeMount.last.ta.value = 'mid';
    // The same document renders to the same blocks: nothing is rebuilt, and
    // the holder standing in for the table is left alone.
    renderMarkdown('| a |\n|---|\n| c |\n\ntail\n', '', container);
    expect(container.querySelector(`.${INSERT_HOLDER_CLASS}`)).not.toBeNull();
    // A change further down rebuilds only that block.
    renderMarkdown('| a |\n|---|\n| c |\n\ntail!\n', '', container);
    expect(container.querySelector(`.${INSERT_HOLDER_CLASS}`)).not.toBeNull();
    expect(container.lastElementChild.textContent).toBe('tail!');
    commitInlineEdit();
    expect(onCommit).toHaveBeenCalledWith('mid');
    expect(container.querySelector('table').parentElement).toBe(container);
  });
});
