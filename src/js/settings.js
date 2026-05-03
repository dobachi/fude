// settings.js - Settings panel UI
import { applyTheme, getCurrentTheme } from './core/theme.js';
import { setFontSize, getFontSize } from './core/editor.js';
import { setMode, getMode } from './core/keymode.js';
import * as backend from './backend.js';

let settingsPanel = null;

export async function openSettings() {
  if (settingsPanel) return;

  let config = {};
  try {
    config = await backend.getConfig();
  } catch {
    /* ignore */
  }

  settingsPanel = document.createElement('div');
  settingsPanel.className = 'settings-overlay';
  settingsPanel.innerHTML = `
    <div class="settings-panel">
      <div class="settings-header">
        <h2>Settings</h2>
        <button class="settings-close icon-btn">\u00d7</button>
      </div>
      <div class="settings-body">
        <div class="setting-group">
          <label>Theme</label>
          <select id="setting-theme">
            <option value="dark"${getCurrentTheme() === 'dark' ? ' selected' : ''}>Dark</option>
            <option value="light"${getCurrentTheme() === 'light' ? ' selected' : ''}>Light</option>
          </select>
        </div>
        <div class="setting-group">
          <label>Font Size: <span id="setting-fontsize-value">${getFontSize()}px</span></label>
          <input type="range" id="setting-fontsize" min="10" max="32" value="${getFontSize()}" />
        </div>
        <div class="setting-group">
          <label>Key Mode</label>
          <select id="setting-keymode">
            <option value="normal"${getMode() === 'normal' ? ' selected' : ''}>Normal</option>
            <option value="vim"${getMode() === 'vim' ? ' selected' : ''}>Vim</option>
            <option value="emacs"${getMode() === 'emacs' ? ' selected' : ''}>Emacs</option>
          </select>
        </div>
        <div class="setting-group">
          <label><input type="checkbox" id="setting-ai-copilot" ${config.features?.ai_copilot ? 'checked' : ''} /> AI Copilot</label>
        </div>
        <div class="setting-group">
          <label><input type="checkbox" id="setting-diff-highlight" ${config.features?.diff_highlight ? 'checked' : ''} /> Diff Highlight</label>
        </div>
        <div class="setting-group">
          <label>OpenRouter API Key</label>
          <input type="password" id="setting-api-key" value="" placeholder="${config.has_api_key ? '••••••••  (saved)' : 'sk-or-...'}" />
          ${config.has_api_key ? `<small class="setting-hint">Stored in: ${config.api_key_storage === 'keychain' ? 'OS Keychain' : 'Config file'}</small>` : ''}
        </div>
      </div>
      <div class="settings-footer">
        <button class="btn-save-settings">Save</button>
      </div>
    </div>
  `;

  document.body.appendChild(settingsPanel);

  settingsPanel.querySelector('.settings-close').addEventListener('click', closeSettings);
  settingsPanel.addEventListener('click', (e) => {
    if (e.target === settingsPanel) closeSettings();
  });

  settingsPanel
    .querySelector('#setting-theme')
    .addEventListener('change', (e) => applyTheme(e.target.value));

  const fontSlider = settingsPanel.querySelector('#setting-fontsize');
  const fontValue = settingsPanel.querySelector('#setting-fontsize-value');
  fontSlider.addEventListener('input', (e) => {
    const size = parseInt(e.target.value, 10);
    setFontSize(size);
    fontValue.textContent = `${size}px`;
  });

  settingsPanel
    .querySelector('#setting-keymode')
    .addEventListener('change', (e) => setMode(e.target.value));
  settingsPanel.querySelector('.btn-save-settings').addEventListener('click', saveSettings);

  const handleEsc = (e) => {
    if (e.key === 'Escape') {
      closeSettings();
      document.removeEventListener('keydown', handleEsc);
    }
  };
  document.addEventListener('keydown', handleEsc);
}

async function saveSettings() {
  // Read existing config first to preserve fields not shown in the UI (e.g. ai_model)
  let existing = {};
  try {
    existing = await backend.getConfig();
  } catch {
    /* ignore */
  }

  const apiKeyValue = document.querySelector('#setting-api-key')?.value || '';

  const config = {
    ...existing,
    theme: document.querySelector('#setting-theme')?.value || 'dark',
    features: {
      ai_copilot: document.querySelector('#setting-ai-copilot')?.checked || false,
      diff_highlight: document.querySelector('#setting-diff-highlight')?.checked || false,
    },
    font_size: parseInt(document.querySelector('#setting-fontsize')?.value || '14', 10),
    key_mode: document.querySelector('#setting-keymode')?.value || 'normal',
    openrouter_api_key: apiKeyValue || null,
  };
  // Keep legacy `vim_mode` field in sync for backward compat
  config.vim_mode = config.key_mode === 'vim';

  try {
    // Save API key separately if provided
    if (apiKeyValue) {
      await backend.setApiKey(apiKeyValue);
      // Don't include the key in the config save
      config.openrouter_api_key = null;
    }
    await backend.saveConfig(config);
  } catch (e) {
    console.error('Failed to save config:', e);
    // Show user-visible error
    const footer = settingsPanel?.querySelector('.settings-footer');
    if (footer) {
      const err = document.createElement('span');
      err.style.cssText = 'color:#f44336;font-size:12px;margin-right:8px';
      err.textContent = 'Save failed: ' + (e.message || e);
      footer.prepend(err);
    }
    return; // Don't close on failure
  }
  closeSettings();
}

export function closeSettings() {
  if (settingsPanel) {
    settingsPanel.remove();
    settingsPanel = null;
  }
}
