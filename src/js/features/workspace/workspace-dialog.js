// workspace-dialog.js - File → ワークスペース…: list the workspaces, add,
// rename and delete them, choose what each keeps, and pick one to switch to.
//
// The dialog edits a copy of the store with the pure operations in
// core/workspaces.js and hands the result back; the app writes it out and
// does any switch (closing tabs, restoring the other session).

import {
  KEEP_ITEMS,
  activeWorkspace,
  findWorkspace,
  addWorkspace,
  renameWorkspace,
  removeWorkspace,
  setKeep,
  nameError,
} from '../../core/workspaces.js';
import { promptDialog } from '../../core/dialog.js';
import { escapeHtml } from '../../core/print-document.js';

const BTN =
  'padding:6px 14px;background:var(--bg-tertiary);color:var(--fg-primary);border:1px solid var(--border);border-radius:4px;cursor:pointer';
const BTN_PRIMARY =
  'padding:6px 14px;background:var(--fg-accent);color:#fff;border:none;border-radius:4px;cursor:pointer';

/**
 * Open the dialog.
 * @param {object} initialStore
 * @param {{prompt?: typeof promptDialog}} [deps] injectable for tests
 * @returns {Promise<{store: object, switchTo: string|null}|null>}
 *   null when closed without any change
 */
export function openWorkspaceDialog(initialStore, deps = {}) {
  const prompt = deps.prompt || promptDialog;
  let store = initialStore;
  let selected = initialStore.active;
  let changed = false;
  let busy = false; // a name prompt is open on top: its keys are its own

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay workspace-overlay';
    overlay.innerHTML = `
      <div class="settings-panel workspace-panel" style="width:460px;max-width:calc(100vw - 32px)">
        <div class="settings-header">
          <h2>ワークスペース</h2>
          <button class="settings-close icon-btn ws-close" aria-label="閉じる">×</button>
        </div>
        <div class="settings-body">
          <ul class="ws-list" role="listbox" aria-label="ワークスペース"></ul>
          <div class="ws-actions">
            <button class="ws-add" style="${BTN}">新規…</button>
            <button class="ws-rename" style="${BTN}">名前を変更…</button>
            <button class="ws-remove" style="${BTN}">削除</button>
          </div>
          <div class="setting-group ws-keep">
            <label class="ws-keep-title"></label>
            ${KEEP_ITEMS.map(
              ({ key, label }) =>
                `<label><input type="checkbox" data-keep="${key}" /> ${escapeHtml(label)}</label>`,
            ).join('')}
            <small class="setting-hint">チェックを外した項目は、このワークスペースでは保存も復元もされません。</small>
          </div>
        </div>
        <div class="settings-footer" style="display:flex;gap:8px;justify-content:flex-end">
          <button class="ws-done" style="${BTN}">閉じる</button>
          <button class="ws-switch" style="${BTN_PRIMARY}">切り替え</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const $ = (sel) => overlay.querySelector(sel);
    const list = $('.ws-list');

    function render() {
      list.textContent = '';
      for (const w of store.workspaces) {
        const li = document.createElement('li');
        li.className = 'ws-item' + (w.name === selected ? ' selected' : '');
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(w.name === selected));
        li.dataset.name = w.name;
        li.tabIndex = -1;
        const name = document.createElement('span');
        name.className = 'ws-name';
        name.textContent = w.name;
        li.appendChild(name);
        if (w.name === store.active) {
          const tag = document.createElement('span');
          tag.className = 'ws-active-tag';
          tag.textContent = '使用中';
          li.appendChild(tag);
        }
        li.addEventListener('click', () => {
          selected = w.name;
          render();
        });
        li.addEventListener('dblclick', () => finish(w.name));
        list.appendChild(li);
      }
      const ws = findWorkspace(store, selected) || activeWorkspace(store);
      $('.ws-keep-title').textContent = `「${ws.name}」で保存する項目`;
      for (const box of overlay.querySelectorAll('[data-keep]')) {
        box.checked = ws.keep[box.dataset.keep] !== false;
      }
      const isActive = ws.name === store.active;
      const remove = $('.ws-remove');
      remove.disabled = isActive || store.workspaces.length <= 1;
      remove.title = isActive ? '使用中のワークスペースは、切り替えてから削除してください' : '';
      const sw = $('.ws-switch');
      sw.disabled = isActive;
      sw.textContent = isActive ? '使用中' : '切り替え';
    }

    function finish(switchTo) {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      if (switchTo && switchTo !== store.active) resolve({ store, switchTo });
      else resolve(changed ? { store, switchTo: null } : null);
    }

    async function askName(message, initial, except) {
      busy = true;
      try {
        for (;;) {
          const name = await prompt(message, initial, 'OK');
          if (name === null) return null;
          const err = nameError(name, store, { except });
          if (!err) return name;
          message = `${err}。別の名前を入力してください`;
          initial = name;
        }
      } finally {
        busy = false;
      }
    }

    $('.ws-add').addEventListener('click', async () => {
      const name = await askName('新しいワークスペースの名前', '');
      if (!name) return;
      store = addWorkspace(store, name);
      selected = name.trim();
      changed = true;
      render();
    });

    $('.ws-rename').addEventListener('click', async () => {
      const name = await askName('新しい名前', selected, selected);
      if (!name || name.trim() === selected) return;
      store = renameWorkspace(store, selected, name);
      selected = name.trim();
      changed = true;
      render();
    });

    $('.ws-remove').addEventListener('click', () => {
      if (selected === store.active || store.workspaces.length <= 1) return;
      store = removeWorkspace(store, selected);
      selected = store.active;
      changed = true;
      render();
    });

    for (const box of overlay.querySelectorAll('[data-keep]')) {
      box.addEventListener('change', () => {
        const ws = findWorkspace(store, selected);
        if (!ws) return;
        store = setKeep(store, selected, { ...ws.keep, [box.dataset.keep]: box.checked });
        changed = true;
      });
    }

    $('.ws-close').addEventListener('click', () => finish(null));
    $('.ws-done').addEventListener('click', () => finish(null));
    $('.ws-switch').addEventListener('click', () => finish(selected));
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay && !busy) finish(null);
    });

    function move(step) {
      const names = store.workspaces.map((w) => w.name);
      const i = names.indexOf(selected);
      selected = names[(i + step + names.length) % names.length];
      render();
      list.querySelector('.ws-item.selected')?.focus();
    }

    function onKey(e) {
      if (busy) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(null);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (e.target && e.target.closest && e.target.closest('.ws-list, .ws-item')) {
          e.preventDefault();
          move(e.key === 'ArrowDown' ? 1 : -1);
        }
      } else if (e.key === 'Enter') {
        if (e.target && e.target.closest && e.target.closest('.ws-item')) {
          e.preventDefault();
          finish(selected);
        }
      }
    }
    document.addEventListener('keydown', onKey, true);

    render();
    list.querySelector('.ws-item.selected')?.focus();
  });
}
