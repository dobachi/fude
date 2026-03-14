// theme.js - Theme management
import { setTheme as setEditorTheme, getCurrentView } from './editor.js';

let currentTheme = 'dark';

export function initTheme(savedTheme = 'dark') {
  applyTheme(savedTheme);
}

export function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);

  const view = getCurrentView();
  if (view) {
    setEditorTheme(view, theme);
  }
}

export function getCurrentTheme() {
  return currentTheme;
}

export function toggleTheme() {
  applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
  return currentTheme;
}
