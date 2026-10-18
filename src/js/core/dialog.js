// dialog.js - Minimal modal prompt/confirm dialogs (Promise-based).
// The Tauri webview doesn't reliably support window.prompt/confirm, so we
// provide small in-app modals styled like the rest of the UI.

import { commonPrefix } from './setup-hosts.js';

function buildOverlay(inner, width = 380) {
  const overlay = document.createElement('div');
  overlay.className = 'settings-overlay';
  overlay.innerHTML = `<div class="settings-panel" style="width:${width}px;max-width:calc(100vw - 32px)">${inner}</div>`;
  document.body.appendChild(overlay);
  return overlay;
}

/**
 * Text input dialog. Resolves with the trimmed string, or null if cancelled.
 * With `opts.complete(typed) → Promise<string[]>`, candidates for what is
 * typed are listed under the field: Tab completes as far as they agree (or
 * to the chosen one), ↑/↓ choose, Enter takes the chosen one, Escape closes
 * the list before the dialog. `opts.debounce` is the wait (ms) before asking.
 * @param {string} message
 * @param {string} [defaultValue]
 * @param {string} [okLabel]
 * @param {{ complete?: (typed: string) => Promise<string[]>, debounce?: number }} [opts]
 */
export function promptDialog(message, defaultValue = '', okLabel = 'OK', opts = {}) {
  const complete = typeof opts.complete === 'function' ? opts.complete : null;
  const debounce = opts.debounce ?? 150;
  return new Promise((resolve) => {
    const overlay = buildOverlay(
      `
      <div class="settings-body" style="padding:16px">
        <p style="margin:0 0 8px;color:var(--fg-primary);font-size:13px">${message}</p>
        <div class="dlg-field" style="position:relative">
          <input class="dlg-input" type="text" spellcheck="false" autocomplete="off" style="width:100%;padding:6px 8px;background:var(--bg-input);border:1px solid var(--border);border-radius:4px;color:var(--fg-primary);font-size:13px" />
          ${complete ? '<ul class="dlg-suggest" role="listbox" style="display:none"></ul>' : ''}
        </div>
        ${complete ? '<small class="setting-hint"><kbd>Tab</kbd> で補完、<kbd>↑</kbd><kbd>↓</kbd> で選択</small>' : ''}
      </div>
      <div class="settings-footer" style="display:flex;gap:8px;justify-content:flex-end">
        <button class="dlg-cancel" style="padding:6px 14px;background:var(--bg-tertiary);color:var(--fg-primary);border:1px solid var(--border);border-radius:4px;cursor:pointer">キャンセル</button>
        <button class="dlg-ok" style="padding:6px 14px;background:var(--fg-accent);color:#fff;border:none;border-radius:4px;cursor:pointer">${okLabel}</button>
      </div>`,
      complete ? 560 : 380,
    );
    const input = overlay.querySelector('.dlg-input');
    input.value = defaultValue;
    let finished = false;
    const done = (val) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const submit = () => {
      const v = input.value.trim();
      done(v ? v : null);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') done(null);
      else if (e.key === 'Enter') submit();
    };

    // ── completion ──
    const list = overlay.querySelector('.dlg-suggest');
    let items = [];
    let active = -1;
    let asked = 0;
    let timer = null;
    const render = () => {
      list.textContent = '';
      items.forEach((text, i) => {
        const li = document.createElement('li');
        li.textContent = text;
        li.title = text;
        li.setAttribute('role', 'option');
        if (i === active) li.className = 'active';
        // mousedown, not click: the field must not lose focus first.
        li.addEventListener('mousedown', (e) => {
          e.preventDefault();
          take(text);
        });
        list.appendChild(li);
      });
      list.style.display = items.length ? '' : 'none';
      list.querySelector('.active')?.scrollIntoView?.({ block: 'nearest' });
    };
    const closeList = () => {
      asked++;
      items = [];
      active = -1;
      render();
    };
    async function suggest() {
      const typed = input.value;
      const mine = ++asked;
      let found = [];
      try {
        found = (await complete(typed)) || [];
      } catch {
        /* a convenience: typing still works without it */
      }
      // A later keystroke, or a closed dialog, makes this answer stale.
      if (finished || mine !== asked || input.value !== typed) return;
      items = found.filter((c) => typeof c === 'string' && c !== typed);
      active = -1;
      render();
    }
    const schedule = () => {
      clearTimeout(timer);
      if (debounce <= 0) suggest();
      else timer = setTimeout(suggest, debounce);
    };
    function take(text) {
      input.value = text;
      closeList();
      input.focus();
      schedule(); // a folder invites the next level
    }
    if (complete) {
      input.addEventListener('input', schedule);
      input.addEventListener('keydown', (e) => {
        if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && items.length) {
          e.preventDefault();
          const step = e.key === 'ArrowDown' ? 1 : -1;
          active =
            active < 0
              ? step > 0
                ? 0
                : items.length - 1
              : (active + step + items.length) % items.length;
          render();
        } else if (e.key === 'Tab' && !e.shiftKey && items.length) {
          e.preventDefault();
          if (active >= 0) return take(items[active]);
          const prefix = commonPrefix(items);
          if (prefix.length > input.value.length) {
            input.value = prefix;
            closeList();
            schedule();
          } else {
            take(items[0]);
          }
        } else if (e.key === 'Enter' && active >= 0) {
          e.preventDefault();
          e.stopPropagation();
          take(items[active]);
        } else if (e.key === 'Escape' && items.length) {
          e.preventDefault();
          e.stopPropagation();
          closeList();
        }
      });
    }

    overlay.querySelector('.dlg-ok').addEventListener('click', submit);
    overlay.querySelector('.dlg-cancel').addEventListener('click', () => done(null));
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) done(null);
    });
    document.addEventListener('keydown', onKey);
    input.focus();
    input.select();
  });
}

/**
 * Confirm dialog. Resolves true/false.
 * @param {string} message
 * @param {{ okLabel?: string, danger?: boolean }} [opts]
 */
export function confirmDialog(message, opts = {}) {
  const { okLabel = 'OK', danger = false } = opts;
  return new Promise((resolve) => {
    const overlay = buildOverlay(`
      <div class="settings-body" style="padding:16px">
        <p style="margin:0;color:var(--fg-primary);font-size:13px;white-space:pre-wrap">${message}</p>
      </div>
      <div class="settings-footer" style="display:flex;gap:8px;justify-content:flex-end">
        <button class="dlg-cancel" style="padding:6px 14px;background:var(--bg-tertiary);color:var(--fg-primary);border:1px solid var(--border);border-radius:4px;cursor:pointer">キャンセル</button>
        <button class="dlg-ok" style="padding:6px 14px;background:${danger ? '#a4262c' : 'var(--fg-accent)'};color:#fff;border:none;border-radius:4px;cursor:pointer">${okLabel}</button>
      </div>`);
    const done = (val) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') done(false);
      else if (e.key === 'Enter') done(true);
    };
    overlay.querySelector('.dlg-ok').addEventListener('click', () => done(true));
    overlay.querySelector('.dlg-cancel').addEventListener('click', () => done(false));
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) done(false);
    });
    document.addEventListener('keydown', onKey);
  });
}
