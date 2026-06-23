// menu.js - Generic right-click context menu.
// showMenu(x, y, items) where items are { label, action, danger? } or
// { separator: true }. The menu closes on selection, outside click, or Escape.

let menuEl = null;
let cleanup = null;

export function closeMenu() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
  if (menuEl) {
    menuEl.remove();
    menuEl = null;
  }
}

/**
 * @param {number} x viewport X
 * @param {number} y viewport Y
 * @param {Array<{label?:string,action?:Function,danger?:boolean,separator?:boolean}>} items
 */
export function showMenu(x, y, items) {
  closeMenu();
  menuEl = document.createElement('div');
  menuEl.className = 'context-menu';

  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'context-menu-sep';
      menuEl.appendChild(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'context-menu-item' + (item.danger ? ' danger' : '');
    const labelSpan = document.createElement('span');
    labelSpan.className = 'context-menu-label';
    labelSpan.textContent = item.label;
    btn.appendChild(labelSpan);
    if (item.shortcut) {
      const sc = document.createElement('span');
      sc.className = 'context-menu-shortcut';
      sc.textContent = item.shortcut;
      btn.appendChild(sc);
    }
    if (item.disabled) btn.disabled = true;
    btn.addEventListener('click', () => {
      closeMenu();
      try {
        item.action?.();
      } catch (e) {
        console.error('Context menu action failed:', e);
      }
    });
    menuEl.appendChild(btn);
  }

  document.body.appendChild(menuEl);

  // Keep within viewport.
  const rect = menuEl.getBoundingClientRect();
  let left = x;
  let top = y;
  if (left + rect.width > window.innerWidth) left = window.innerWidth - rect.width - 8;
  if (top + rect.height > window.innerHeight) top = window.innerHeight - rect.height - 8;
  menuEl.style.left = `${Math.max(4, left)}px`;
  menuEl.style.top = `${Math.max(4, top)}px`;

  const onDocMouseDown = (e) => {
    if (menuEl && !menuEl.contains(e.target)) closeMenu();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') closeMenu();
  };
  const onScroll = () => closeMenu();
  // Defer so the opening right-click doesn't immediately close it.
  setTimeout(() => document.addEventListener('mousedown', onDocMouseDown), 0);
  document.addEventListener('keydown', onKey);
  window.addEventListener('blur', closeMenu);
  document.addEventListener('scroll', onScroll, true);
  cleanup = () => {
    document.removeEventListener('mousedown', onDocMouseDown);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('blur', closeMenu);
    document.removeEventListener('scroll', onScroll, true);
  };
}
