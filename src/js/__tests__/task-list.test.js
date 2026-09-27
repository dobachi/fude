import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import markdownIt from 'markdown-it';
import { taskListPlugin, taskToggleChange, isTaskCheckbox } from '../core/task-list.js';
import { renderMarkdown, initPreview } from '../core/preview.js';

function render(src) {
  const md = markdownIt();
  md.use(taskListPlugin);
  const div = document.createElement('div');
  div.innerHTML = md.render(src);
  return div;
}

/** Apply a taskToggleChange result to a whole document string. */
function applyChange(doc, change) {
  return doc.slice(0, change.from) + change.insert + doc.slice(change.to);
}

describe('taskListPlugin', () => {
  it('renders unchecked and checked markers as checkboxes', () => {
    const div = render('- [ ] todo\n- [x] done\n- [X] DONE\n');
    const boxes = div.querySelectorAll('input.task-list-item-checkbox');
    expect(boxes).toHaveLength(3);
    expect(boxes[0].hasAttribute('checked')).toBe(false);
    expect(boxes[1].hasAttribute('checked')).toBe(true);
    expect(boxes[2].hasAttribute('checked')).toBe(true);
  });

  it('strips the marker from the item text', () => {
    const div = render('- [ ] buy milk\n');
    expect(div.querySelector('li').textContent).toBe('buy milk');
  });

  it('marks the item and its list with classes', () => {
    const div = render('- [ ] a\n- plain\n');
    const items = div.querySelectorAll('li');
    expect(items[0].classList.contains('task-list-item')).toBe(true);
    expect(items[1].classList.contains('task-list-item')).toBe(false);
    expect(div.querySelector('ul').className).toBe('contains-task-list');
  });

  it('adds contains-task-list only once per list', () => {
    const div = render('- [ ] a\n- [ ] b\n');
    expect(div.querySelector('ul').className).toBe('contains-task-list');
  });

  it('works in ordered lists and nested lists', () => {
    const div = render('1. [x] one\n   - [ ] nested\n');
    expect(div.querySelectorAll('input.task-list-item-checkbox')).toHaveLength(2);
    expect(div.querySelector('ol').className).toBe('contains-task-list');
    expect(div.querySelector('ol ul').className).toBe('contains-task-list');
  });

  it('works in loose lists', () => {
    const div = render('- [ ] a\n\n- [x] b\n');
    expect(div.querySelectorAll('li > p > input.task-list-item-checkbox')).toHaveLength(2);
  });

  it('accepts an item that is only a marker', () => {
    const div = render('- [ ]\n');
    expect(div.querySelectorAll('input.task-list-item-checkbox')).toHaveLength(1);
  });

  it('ignores a marker not followed by whitespace', () => {
    const div = render('- [ ]x\n- [x]y\n');
    expect(div.querySelector('input')).toBeNull();
  });

  it('ignores brackets outside list items', () => {
    const div = render('[ ] not a task\n\n> [x] quoted\n');
    expect(div.querySelector('input')).toBeNull();
  });

  it('ignores a marker that is not at the start of the item', () => {
    const div = render('- see [ ] here\n');
    expect(div.querySelector('input')).toBeNull();
  });

  it('ignores a marker on a continuation line of the item', () => {
    const div = render('-\n  [ ] later\n');
    expect(div.querySelector('input')).toBeNull();
  });

  it('keeps inline formatting after the marker', () => {
    const div = render('- [ ] **bold** task\n');
    expect(div.querySelector('li strong').textContent).toBe('bold');
  });
});

describe('isTaskCheckbox', () => {
  it('recognises the rendered checkbox only', () => {
    const div = render('- [ ] a\n');
    expect(isTaskCheckbox(div.querySelector('input'))).toBe(true);
    expect(isTaskCheckbox(div.querySelector('li'))).toBe(false);
    expect(isTaskCheckbox(null)).toBe(false);
  });
});

describe('taskToggleChange', () => {
  it('checks an unchecked task', () => {
    const line = '- [ ] todo';
    const c = taskToggleChange(line, 0, false);
    expect(applyChange(line, c)).toBe('- [x] todo');
  });

  it('unchecks a checked task (either case)', () => {
    expect(applyChange('- [x] a', taskToggleChange('- [x] a', 0, true))).toBe('- [ ] a');
    expect(applyChange('- [X] a', taskToggleChange('- [X] a', 0, true))).toBe('- [ ] a');
  });

  it('offsets the change by the line start', () => {
    const doc = 'intro\n- [ ] todo\n';
    const c = taskToggleChange('- [ ] todo', 6, false);
    expect(applyChange(doc, c)).toBe('intro\n- [x] todo\n');
  });

  it('handles every bullet and ordinal style', () => {
    for (const prefix of ['- ', '* ', '+ ', '1. ', '12) ']) {
      const line = `${prefix}[ ] a`;
      expect(applyChange(line, taskToggleChange(line, 0, false))).toBe(`${prefix}[x] a`);
    }
  });

  it('handles indentation and blockquote prefixes', () => {
    for (const prefix of ['    - ', '\t- ', '> - ', '> >   1. ']) {
      const line = `${prefix}[x] a`;
      expect(applyChange(line, taskToggleChange(line, 0, true))).toBe(`${prefix}[ ] a`);
    }
  });

  it('handles a marker at the end of the line', () => {
    expect(applyChange('- [ ]', taskToggleChange('- [ ]', 0, false))).toBe('- [x]');
  });

  it('refuses when the source disagrees with what was rendered', () => {
    expect(taskToggleChange('- [x] a', 0, false)).toBeNull();
    expect(taskToggleChange('- [ ] a', 0, true)).toBeNull();
  });

  it('refuses lines without a task marker', () => {
    expect(taskToggleChange('- plain', 0, false)).toBeNull();
    expect(taskToggleChange('[ ] no bullet', 0, false)).toBeNull();
    expect(taskToggleChange('- [ ]x', 0, false)).toBeNull();
    expect(taskToggleChange('- [y] a', 0, false)).toBeNull();
    expect(taskToggleChange('', 0, false)).toBeNull();
  });

  it('only touches the first marker on the line', () => {
    const line = '- [ ] a [ ] b';
    expect(applyChange(line, taskToggleChange(line, 0, false))).toBe('- [x] a [ ] b');
  });
});

describe('preview checkbox click', () => {
  let container;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it('reports the source line and rendered state, and does not flip the box itself', () => {
    const onTaskToggle = vi.fn();
    initPreview(container, { onTaskToggle });
    renderMarkdown('# Title\n\n- a\n- [ ] b\n- [x] c\n', '', container);

    const boxes = container.querySelectorAll('input.task-list-item-checkbox');
    boxes[0].click();
    expect(onTaskToggle).toHaveBeenLastCalledWith(4, false, container);
    expect(boxes[0].checked).toBe(false);

    boxes[1].click();
    expect(onTaskToggle).toHaveBeenLastCalledWith(5, true, container);
    expect(boxes[1].checked).toBe(true);
  });

  it('reports the right line in a loose list', () => {
    const onTaskToggle = vi.fn();
    initPreview(container, { onTaskToggle });
    renderMarkdown('- [ ] a\n\n- [ ] b\n', '', container);

    container.querySelectorAll('input.task-list-item-checkbox')[1].click();
    expect(onTaskToggle).toHaveBeenCalledWith(3, false, container);
  });

  it('round-trips: the reported line and state produce the intended source edit', () => {
    const src = 'x\n\n> - [ ] quoted task\n';
    const onTaskToggle = vi.fn();
    initPreview(container, { onTaskToggle });
    renderMarkdown(src, '', container);

    container.querySelector('input.task-list-item-checkbox').click();
    const [line, wasChecked] = onTaskToggle.mock.calls[0];
    const lines = src.split('\n');
    const from = lines.slice(0, line - 1).join('\n').length + 1;
    const c = taskToggleChange(lines[line - 1], from, wasChecked);
    expect(applyChange(src, c)).toBe('x\n\n> - [x] quoted task\n');
  });

  it('keeps the box unchanged when no handler is registered', () => {
    initPreview(container, {});
    renderMarkdown('- [ ] a\n', '', container);
    const box = container.querySelector('input.task-list-item-checkbox');
    box.click();
    expect(box.checked).toBe(false);
  });

  it('toggles only on the first click of a double-click', () => {
    const onTaskToggle = vi.fn();
    initPreview(container, { onTaskToggle });
    renderMarkdown('- [ ] a\n', '', container);
    const box = container.querySelector('input.task-list-item-checkbox');
    for (const detail of [1, 2]) {
      box.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail }));
    }
    expect(onTaskToggle).toHaveBeenCalledTimes(1);
    expect(box.checked).toBe(false);
  });

  it('does not open a block edit on a checkbox double-click', () => {
    const onBlockEdit = vi.fn();
    initPreview(container, { onBlockEdit });
    renderMarkdown('- [ ] a\n', '', container);
    container
      .querySelector('input.task-list-item-checkbox')
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(onBlockEdit).not.toHaveBeenCalled();
  });
});
