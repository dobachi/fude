// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { promptDialog } from '../core/dialog.js';

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const key = (el, k, extra = {}) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...extra }));
const typeInto = (input, value) => {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
const shown = () => [...document.querySelectorAll('.dlg-suggest li')].map((li) => li.textContent);

describe('promptDialog の補完', () => {
  let complete;
  beforeEach(() => {
    document.body.innerHTML = '';
    complete = vi.fn(async (typed) =>
      ['k16:/home/u/notes/', 'k16:/home/u/note.md'].filter((c) => c.startsWith(typed)),
    );
  });

  function open(initial = 'k16:/home/u/') {
    const result = promptDialog('保存先', initial, '保存', { complete, debounce: 0 });
    const input = document.querySelector('.dlg-input');
    return { result, input };
  }

  it('入力すると候補が出る', async () => {
    const { input } = open();
    typeInto(input, 'k16:/home/u/no');
    await flush();
    expect(complete).toHaveBeenLastCalledWith('k16:/home/u/no');
    expect(shown()).toEqual(['k16:/home/u/notes/', 'k16:/home/u/note.md']);
  });

  it('Tab は候補の共通部分まで補い、1 つに絞れたらそれにする', async () => {
    const { input } = open();
    typeInto(input, 'k16:/home/u/n');
    await flush();
    key(input, 'Tab');
    expect(input.value).toBe('k16:/home/u/note');
    await flush();
    typeInto(input, 'k16:/home/u/note.');
    await flush();
    key(input, 'Tab');
    expect(input.value).toBe('k16:/home/u/note.md');
  });

  it('↓ で選んで Enter はその候補を入れるだけで、保存はまだしない', async () => {
    const { result, input } = open();
    typeInto(input, 'k16:/home/u/no');
    await flush();
    key(input, 'ArrowDown');
    key(input, 'Enter');
    expect(input.value).toBe('k16:/home/u/notes/');
    expect(document.querySelector('.dlg-input')).not.toBeNull();
    key(input, 'Escape'); // closes the list (if any) …
    await flush();
    key(input, 'Escape'); // … then the dialog
    await expect(result).resolves.toBeNull();
  });

  it('候補が出ている間の Escape は候補だけを閉じる', async () => {
    const { input } = open();
    typeInto(input, 'k16:/home/u/no');
    await flush();
    key(input, 'Escape');
    expect(shown()).toEqual([]);
    expect(document.querySelector('.dlg-input')).not.toBeNull();
  });

  it('候補を選んでいなければ Enter で決定する', async () => {
    const { result, input } = open();
    typeInto(input, 'k16:/home/u/new.md');
    await flush();
    key(input, 'Enter');
    await expect(result).resolves.toBe('k16:/home/u/new.md');
  });

  it('遅れて届いた古い候補は出さない', async () => {
    let release;
    complete.mockImplementationOnce(() => new Promise((r) => (release = () => r(['k16:/old']))));
    const { input } = open();
    typeInto(input, 'k16:/o');
    await flush();
    typeInto(input, 'k16:/home/u/no');
    await flush();
    release();
    await flush();
    expect(shown()).not.toContain('k16:/old');
  });

  it('補完が失敗しても入力は続けられる', async () => {
    complete.mockRejectedValue(new Error('gone'));
    const { result, input } = open();
    typeInto(input, 'k16:/x.md');
    await flush();
    expect(shown()).toEqual([]);
    key(input, 'Enter');
    await expect(result).resolves.toBe('k16:/x.md');
  });

  it('補完を渡さなければ従来どおり', async () => {
    const result = promptDialog('名前', 'a.md');
    const input = document.querySelector('.dlg-input');
    expect(document.querySelector('.dlg-suggest')).toBeNull();
    key(input, 'Enter');
    await expect(result).resolves.toBe('a.md');
  });
});
