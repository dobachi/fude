// menubar.js - Hideable application menu bar.
//
// Renders a row of top-level menus ("ファイル", "編集", ...) whose dropdowns
// reuse the tested showMenu() component. Visibility is toggled by a shortcut
// (wired in app.js) and persisted to localStorage; the bar is hidden by default.

import { showMenu, closeMenu } from './menu.js';

const VISIBLE_KEY = 'fude.menuBarVisible';

let barEl = null;
/** @type {Array<{label:string, items: any[]|(() => any[])}>} */
let menuDef = [];
let openIndex = -1;

/** Whether the menu bar is currently shown. */
export function isMenuBarVisible() {
  return !!barEl && !barEl.classList.contains('hidden');
}

/** Show or hide the menu bar and persist the choice. */
export function setMenuBarVisible(visible) {
  if (!barEl) return;
  barEl.classList.toggle('hidden', !visible);
  if (!visible) {
    closeMenu();
    openIndex = -1;
    syncOpenClass();
  }
  try {
    localStorage.setItem(VISIBLE_KEY, visible ? '1' : '0');
  } catch {
    /* storage may be unavailable */
  }
}

/** Toggle menu bar visibility. */
export function toggleMenuBar() {
  setMenuBarVisible(!isMenuBarVisible());
}

/** Read the persisted visibility (default: hidden). */
export function getStoredMenuBarVisible() {
  try {
    return localStorage.getItem(VISIBLE_KEY) === '1';
  } catch {
    return false;
  }
}

function syncOpenClass() {
  if (!barEl) return;
  const btns = barEl.querySelectorAll('.menu-bar-item');
  btns.forEach((b, i) => b.classList.toggle('open', i === openIndex));
}

/** Resolve a menu's items (supports a function for dynamic state). */
function itemsFor(menu) {
  return typeof menu.items === 'function' ? menu.items() : menu.items;
}

function openMenuAt(index) {
  if (!barEl) return;
  const btn = barEl.querySelectorAll('.menu-bar-item')[index];
  if (!btn) return;
  const rect = btn.getBoundingClientRect();
  openIndex = index;
  syncOpenClass();
  // Anchor the dropdown just under the menu button.
  showMenu(rect.left, rect.bottom, itemsFor(menuDef[index]));
}

/**
 * Build the menu bar into `container`.
 * @param {HTMLElement} container the #menu-bar element
 * @param {Array<{label:string, items:any[]|(() => any[])}>} menus
 */
export function initMenuBar(container, menus) {
  barEl = container;
  menuDef = menus;
  container.innerHTML = '';

  menus.forEach((menu, index) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'menu-bar-item';
    btn.textContent = menu.label;
    btn.setAttribute('role', 'menuitem');

    btn.addEventListener('click', () => {
      // Toggle: clicking the open menu closes it.
      if (openIndex === index) {
        closeMenu();
        openIndex = -1;
        syncOpenClass();
      } else {
        openMenuAt(index);
      }
    });

    // Classic menu-bar behavior: once a menu is open, hovering another switches.
    btn.addEventListener('mouseenter', () => {
      if (openIndex !== -1 && openIndex !== index) openMenuAt(index);
    });

    container.appendChild(btn);
  });

  // Reflect the persisted state on startup (default hidden).
  setMenuBarVisible(getStoredMenuBarVisible());
}
