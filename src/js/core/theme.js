// theme.js - Theme management
import { setTheme as setEditorTheme, getCurrentView } from './editor.js';
import { applyThemeToAllPanes } from './panes.js';

let currentTheme = 'dark';

export function initTheme(savedTheme = 'dark') {
  applyTheme(savedTheme);
}

export function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);

  // Apply to all panes (handles multi-pane case)
  applyThemeToAllPanes(theme);

  // Fallback: also apply to single active view if panes not ready yet
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
