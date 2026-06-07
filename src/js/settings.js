// settings.js - Settings panel UI
import { applyTheme, getCurrentTheme } from './core/theme.js';
import { setFontSize, getFontSize } from './core/editor.js';
import { setMode, getMode } from './core/keymode.js';
import * as backend from './backend.js';
import { openModelPicker } from './features/ai/model-picker-modal.js';
import { loadCatalogue, findModelById, persistModelChoice } from './features/ai/model-store.js';
import { DEFAULT_MODEL } from './features/ai/openrouter-client.js';

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
        <div class="setting-group setting-models">
          <label>AI Models</label>
          <div class="model-row" data-feature="default">
            <span class="model-row-label">Default</span>
            <button class="model-row-btn" type="button">…</button>
          </div>
          <div class="model-row" data-feature="chat">
            <span class="model-row-label">Chat</span>
            <button class="model-row-btn" type="button">…</button>
            <button class="model-row-reset icon-btn" type="button" title="Use default" aria-label="Use default">↺</button>
          </div>
          <div class="model-row" data-feature="composer">
            <span class="model-row-label">Composer</span>
            <button class="model-row-btn" type="button">…</button>
            <button class="model-row-reset icon-btn" type="button" title="Use default" aria-label="Use default">↺</button>
          </div>
          <div class="model-row" data-feature="inline">
            <span class="model-row-label">Inline</span>
            <button class="model-row-btn" type="button">…</button>
            <button class="model-row-reset icon-btn" type="button" title="Use default" aria-label="Use default">↺</button>
          </div>
          <small class="setting-hint">Per-task selections fall back to the default if left empty.</small>
        </div>
        <div class="setting-group setting-extensions">
          <label>拡張機能 / Extensions</label>
          <div class="ext-row" data-ext="plantuml">
            <label><input type="checkbox" id="setting-plantuml" ${config.features?.plantuml_preview ? 'checked' : ''} /> PlantUML Preview</label>
            <span class="ext-status" id="ext-status-plantuml"></span>
            <div class="ext-progress" id="ext-progress-plantuml" style="display:none"><div class="ext-progress-bar"></div></div>
          </div>
          <small class="setting-hint">有効化すると初回のみ描画エンジン（約十数MB）をダウンロードします。コードブロックを <code>\`\`\`plantuml</code> で記述するとプレビューに図が表示されます。</small>
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

  // Model rows: each row shows the current selection (or "Use default" for
  // unset per-task rows) and opens the picker on click.
  setupModelRows(config).catch((e) => console.error('Model rows setup failed:', e));

  // Extensions: show install state and handle on-demand download.
  setupExtensions().catch((e) => console.error('Extensions setup failed:', e));

  const handleEsc = (e) => {
    if (e.key === 'Escape') {
      closeSettings();
      document.removeEventListener('keydown', handleEsc);
    }
  };
  document.addEventListener('keydown', handleEsc);
}

async function setupExtensions() {
  const cb = settingsPanel?.querySelector('#setting-plantuml');
  const statusEl = settingsPanel?.querySelector('#ext-status-plantuml');
  const progEl = settingsPanel?.querySelector('#ext-progress-plantuml');
  const bar = progEl?.querySelector('.ext-progress-bar');
  if (!cb || !statusEl) return;

  let installed = false;
  try {
    const st = await backend.extensionStatus('plantuml');
    installed = !!st.installed;
  } catch {
    /* ignore (e.g. browser mode) */
  }
  statusEl.textContent = installed ? '導入済み' : '未導入';

  cb.addEventListener('change', async () => {
    if (!cb.checked) {
      statusEl.textContent = installed ? '導入済み（無効）' : '未導入';
      return;
    }
    if (installed) {
      statusEl.textContent = '導入済み';
      return;
    }
    // First enable: download the engine.
    cb.disabled = true;
    if (progEl) progEl.style.display = '';
    if (bar) bar.style.width = '0%';
    statusEl.textContent = 'ダウンロード中…';
    await new Promise((resolve) => {
      backend.installExtension(
        'plantuml',
        (p, t) => {
          const pct = t ? Math.round((p / t) * 100) : 0;
          if (bar) bar.style.width = `${pct}%`;
          statusEl.textContent = `ダウンロード中… ${pct}%`;
        },
        () => {
          installed = true;
          statusEl.textContent = '導入済み';
          if (progEl) progEl.style.display = 'none';
          cb.disabled = false;
          resolve();
        },
        (err) => {
          statusEl.textContent = `失敗: ${err.message}`;
          if (progEl) progEl.style.display = 'none';
          cb.checked = false;
          cb.disabled = false;
          resolve();
        },
      );
    });
  });
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
      plantuml_preview: document.querySelector('#setting-plantuml')?.checked || false,
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
    // Let the app live-apply changes (e.g. enable PlantUML preview) without restart.
    window.dispatchEvent(new CustomEvent('fude:config-saved', { detail: config }));
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

// ── Model rows ────────────────────────────────────────────────────────────

const MODEL_FEATURE_FIELDS = {
  default: 'ai_model',
  chat: 'ai_model_chat',
  composer: 'ai_model_composer',
  inline: 'ai_model_inline',
};

const MODEL_TITLES = {
  default: 'Default model',
  chat: 'Chat model',
  composer: 'Composer model',
  inline: 'Inline completion model',
};

async function setupModelRows(initialConfig) {
  if (!settingsPanel) return;
  // Snapshot the config locally so a Save in another tab doesn't surprise us.
  let liveConfig = initialConfig ? { ...initialConfig } : {};

  // Preload the model catalogue so labels resolve without flicker.
  let catalogue = [];
  try {
    catalogue = await loadCatalogue();
  } catch {
    catalogue = [];
  }

  const rows = settingsPanel.querySelectorAll('.model-row');

  const refreshAll = () => {
    rows.forEach((row) => {
      const feature = row.dataset.feature;
      const field = MODEL_FEATURE_FIELDS[feature];
      const explicit = liveConfig[field];
      const btn = row.querySelector('.model-row-btn');
      const reset = row.querySelector('.model-row-reset');
      if (feature === 'default') {
        const id = explicit || DEFAULT_MODEL;
        const m = findModelById(catalogue, id);
        btn.textContent = m?.name || id;
        btn.title = id;
      } else if (explicit) {
        const m = findModelById(catalogue, explicit);
        btn.textContent = m?.name || explicit;
        btn.title = explicit;
        if (reset) reset.classList.remove('hidden');
      } else {
        btn.textContent = 'Use default';
        btn.title = '';
        if (reset) reset.classList.add('hidden');
      }
    });
  };
  refreshAll();

  rows.forEach((row) => {
    const feature = row.dataset.feature;
    const btn = row.querySelector('.model-row-btn');
    const reset = row.querySelector('.model-row-reset');

    btn.addEventListener('click', async () => {
      const field = MODEL_FEATURE_FIELDS[feature];
      const picked = await openModelPicker({
        currentId: liveConfig[field] || (feature === 'default' ? DEFAULT_MODEL : null),
        title: MODEL_TITLES[feature],
        allowUnset: feature !== 'default',
      });
      if (picked === undefined) return; // user cancelled with Esc — leave as is
      try {
        await persistModelChoice(feature, picked);
        liveConfig[field] = picked || null;
        refreshAll();
      } catch (e) {
        console.error('Failed to persist model choice:', e);
      }
    });

    if (reset) {
      reset.addEventListener('click', async () => {
        try {
          await persistModelChoice(feature, null);
          liveConfig[MODEL_FEATURE_FIELDS[feature]] = null;
          refreshAll();
        } catch (e) {
          console.error('Failed to reset model choice:', e);
        }
      });
    }
  });
}
