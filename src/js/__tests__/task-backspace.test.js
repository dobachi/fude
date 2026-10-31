import { describe, it, expect, afterEach } from 'vitest';
import { runScopeHandlers } from '@codemirror/view';
import { createEditor } from '../core/editor.js';

// Through the real editor keymap: our Backspace must win over the Markdown
// keymap's deleteMarkupBackward, which would drop the bullet as well.
const containers = [];
afterEach(() => {
  for (const c of containers.splice(0)) c.remove();
});

function editorWith(text) {
  const caret = text.indexOf('|');
  const container = document.createElement('div');
  document.body.appendChild(container);
  containers.push(container);
  const view = createEditor(container, text.replace('|', ''));
  view.dispatch({ selection: { anchor: caret } });
  return view;
}

function backspace(view) {
  const ev = new KeyboardEvent('keydown', { key: 'Backspace', keyCode: 8, bubbles: true });
  return runScopeHandlers(view, ev, 'editor');
}

describe('Backspace after a task marker in the editor', () => {
  it('removes the checkbox but keeps the bullet', () => {
    const view = editorWith('- [ ] |todo');
    expect(backspace(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('- todo');
    expect(view.state.selection.main.head).toBe(2);
    view.destroy();
  });

  it('a second Backspace then removes the bullet as before', () => {
    const view = editorWith('- [x] |done');
    backspace(view);
    backspace(view);
    expect(view.state.doc.toString()).not.toContain('-');
    expect(view.state.doc.toString().trim()).toBe('done');
    view.destroy();
  });

  it('on an empty task item too', () => {
    const view = editorWith('- [ ] |');
    backspace(view);
    expect(view.state.doc.toString()).toBe('- ');
    view.destroy();
  });
});
