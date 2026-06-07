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
          <div class="ext-row" data-ext="plantuml-archimate">
            <label><input type="checkbox" id="setting-archimate" /> PlantUML ArchiMate (stdlib)</label>
            <span class="ext-status" id="ext-status-archimate"></span>
            <div class="ext-progress" id="ext-progress-archimate" style="display:none"><div class="ext-progress-bar"></div></div>
          </div>
          <small class="setting-hint">PlantUML: 有効化すると初回のみ描画エンジン（約十数MB）をダウンロード。 ArchiMate: <code>!include &lt;archimate/Archimate&gt;</code> をローカルで解決（PlantUML本体が前提・自動導入）。</small>
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

// Download an extension showing progress in the given row elements.
// Resolves true on success, false on failure.
function installExtensionWithProgress(id, statusEl, progEl, bar) {
  if (progEl) progEl.style.display = '';
  if (bar) bar.style.width = '0%';
  statusEl.textContent = 'ダウンロード中…';
  return new Promise((resolve) => {
    backend.installExtension(
      id,
      (p, t) => {
        const pct = t ? Math.round((p / t) * 100) : 0;
        if (bar) bar.style.width = `${pct}%`;
        statusEl.textContent = `ダウンロード中… ${pct}%`;
      },
      () => {
        statusEl.textContent = '導入済み';
        if (progEl) progEl.style.display = 'none';
        resolve(true);
      },
      (err) => {
        statusEl.textContent = `失敗: ${err.message}`;
        if (progEl) progEl.style.display = 'none';
        resolve(false);
      },
    );
  });
}

async function isInstalled(id) {
  try {
    const st = await backend.extensionStatus(id);
    return !!st.installed;
  } catch {
    return false;
  }
}

async function setupExtensions() {
  const panel = settingsPanel;
  if (!panel) return;

  // --- PlantUML engine (gated by features.plantuml_preview) ---
  const cb = panel.querySelector('#setting-plantuml');
  const statusEl = panel.querySelector('#ext-status-plantuml');
  const progEl = panel.querySelector('#ext-progress-plantuml');
  const bar = progEl?.querySelector('.ext-progress-bar');

  // --- ArchiMate stdlib (state = installed) ---
  const acb = panel.querySelector('#setting-archimate');
  const aStatus = panel.querySelector('#ext-status-archimate');
  const aProg = panel.querySelector('#ext-progress-archimate');
  const aBar = aProg?.querySelector('.ext-progress-bar');

  let plantumlInstalled = await isInstalled('plantuml');
  if (statusEl) statusEl.textContent = plantumlInstalled ? '導入済み' : '未導入';

  let archimateInstalled = await isInstalled('plantuml-archimate');
  if (acb) acb.checked = archimateInstalled;
  if (aStatus) aStatus.textContent = archimateInstalled ? '導入済み' : '未導入';

  if (cb && statusEl) {
    cb.addEventListener('change', async () => {
      if (!cb.checked) {
        statusEl.textContent = plantumlInstalled ? '導入済み（無効）' : '未導入';
        return;
      }
      if (plantumlInstalled) {
        statusEl.textContent = '導入済み';
        return;
      }
      cb.disabled = true;
      const ok = await installExtensionWithProgress('plantuml', statusEl, progEl, bar);
      plantumlInstalled = ok;
      cb.checked = ok;
      cb.disabled = false;
    });
  }

  if (acb && aStatus) {
    acb.addEventListener('change', async () => {
      if (!acb.checked) {
        // Uninstall the stdlib pack (files kept-or-removed is fine; remove to be tidy).
        try {
          await backend.uninstallExtension('plantuml-archimate');
        } catch {
          /* ignore */
        }
        archimateInstalled = false;
        aStatus.textContent = '未導入';
        return;
      }
      if (archimateInstalled) {
        aStatus.textContent = '導入済み';
        return;
      }
      acb.disabled = true;
      // ArchiMate needs the engine — install it first if missing.
      if (!plantumlInstalled) {
        const okEngine = await installExtensionWithProgress('plantuml', statusEl, progEl, bar);
        plantumlInstalled = okEngine;
        if (cb) cb.checked = okEngine;
        if (!okEngine) {
          acb.checked = false;
          acb.disabled = false;
          return;
        }
      }
      const ok = await installExtensionWithProgress('plantuml-archimate', aStatus, aProg, aBar);
      archimateInstalled = ok;
      acb.checked = ok;
      acb.disabled = false;
    });
  }
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
