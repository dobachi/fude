import { describe, it, expect, beforeEach } from 'vitest';
import { openWorkspaceDialog } from '../features/workspace/workspace-dialog.js';
import { normalizeStore, addWorkspace, findWorkspace } from '../core/workspaces.js';

const base = () => addWorkspace(normalizeStore(null, null), 'notes');
const q = (sel) => document.querySelector(sel);
const items = () => [...document.querySelectorAll('.ws-item')];
const click = (sel) => q(sel).click();
const tick = () => new Promise((r) => setTimeout(r, 0));

// A scripted prompt: answers in order, recording what it was asked.
function scriptedPrompt(answers) {
  const asked = [];
  const fn = async (message) => {
    asked.push(message);
    return answers.length ? answers.shift() : null;
  };
  fn.asked = asked;
  return fn;
}

describe('workspace dialog', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('lists the workspaces with the active one selected and marked', () => {
    openWorkspaceDialog(base());
    expect(items().map((li) => li.dataset.name)).toEqual(['default', 'notes']);
    expect(q('.ws-item.selected').dataset.name).toBe('default');
    expect(q('.ws-item.selected .ws-active-tag').textContent).toBe('使用中');
    expect(q('.ws-switch').disabled).toBe(true);
    expect(q('.ws-remove').disabled).toBe(true); // the active one
  });

  it('closing without changes resolves null', async () => {
    const p = openWorkspaceDialog(base());
    click('.ws-done');
    expect(await p).toBeNull();
    expect(q('.workspace-overlay')).toBeNull();
  });

  it('switches to the selected workspace', async () => {
    const p = openWorkspaceDialog(base());
    items()[1].click();
    expect(q('.ws-switch').disabled).toBe(false);
    click('.ws-switch');
    const r = await p;
    expect(r.switchTo).toBe('notes');
  });

  it('adds a workspace, re-asking after an unusable name', async () => {
    const prompt = scriptedPrompt(['notes', '執筆']);
    const p = openWorkspaceDialog(base(), { prompt });
    click('.ws-add');
    await tick();
    await tick();
    expect(prompt.asked[1]).toMatch(/既に/);
    expect(items().map((li) => li.dataset.name)).toEqual(['default', 'notes', '執筆']);
    expect(q('.ws-item.selected').dataset.name).toBe('執筆');
    click('.ws-done');
    const r = await p;
    expect(r.switchTo).toBeNull();
    expect(findWorkspace(r.store, '執筆')).toBeTruthy();
  });

  it('renames the active workspace and keeps it active', async () => {
    const p = openWorkspaceDialog(base(), { prompt: scriptedPrompt(['仕事']) });
    click('.ws-rename');
    await tick();
    click('.ws-done');
    const r = await p;
    expect(r.store.active).toBe('仕事');
    expect(r.switchTo).toBeNull();
  });

  it('deletes a workspace that is not in use', async () => {
    const p = openWorkspaceDialog(base());
    items()[1].click();
    click('.ws-remove');
    expect(items().map((li) => li.dataset.name)).toEqual(['default']);
    click('.ws-done');
    expect((await p).store.workspaces).toHaveLength(1);
  });

  it('edits what the selected workspace keeps', async () => {
    const p = openWorkspaceDialog(base());
    items()[1].click();
    expect(q('.ws-keep-title').textContent).toContain('notes');
    const tabs = q('[data-keep="tabs"]');
    expect(tabs.checked).toBe(true);
    tabs.checked = false;
    tabs.dispatchEvent(new Event('change'));
    click('.ws-done');
    const r = await p;
    expect(findWorkspace(r.store, 'notes').keep.tabs).toBe(false);
    expect(findWorkspace(r.store, 'default').keep.tabs).toBe(true);
  });

  it('Escape closes, but not while a name prompt is open', async () => {
    let release;
    const prompt = () => new Promise((r) => (release = r));
    const p = openWorkspaceDialog(base(), { prompt });
    click('.ws-add');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(q('.workspace-overlay')).not.toBeNull();
    release(null);
    await tick();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(await p).toBeNull();
  });

  it('escapes workspace names', () => {
    const store = addWorkspace(normalizeStore(null, null), '<b>x</b>');
    openWorkspaceDialog(store);
    expect(items()[1].querySelector('.ws-name').textContent).toBe('<b>x</b>');
    expect(q('.ws-list b')).toBeNull();
  });
});
