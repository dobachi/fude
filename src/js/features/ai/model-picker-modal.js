// model-picker-modal.js - Cmd+P style searchable modal for picking an
// OpenRouter model. Keyboard-first (Esc closes, ↑↓ navigate, Enter selects),
// also reachable with the mouse. Self-contained: lifecycle is open → user
// picks or cancels → DOM removed.

import { loadCatalogue, clearCatalogueCache } from './model-store.js';

const SORT_OPTIONS = [
  { key: 'name', label: 'Name' },
  { key: 'provider', label: 'Provider' },
  { key: 'context', label: 'Context' },
  { key: 'price', label: 'Price' },
];

let currentInstance = null;

/**
 * Open the model picker modal. Resolves with the selected model id, or null
 * if the user cancels (Esc, overlay click, or the explicit "Use default"
 * button when `allowUnset` is true).
 *
 * @param {object} opts
 * @param {string|null} [opts.currentId] - Currently chosen id to pre-select.
 * @param {string}      [opts.title]     - Modal title shown at the top.
 * @param {boolean}     [opts.allowUnset] - Show a "Use default" button that resolves with null.
 * @returns {Promise<string|null>}
 */
export function openModelPicker(opts = {}) {
  if (currentInstance) {
    // Replace existing modal — most recent caller wins.
    currentInstance.cancel();
  }

  return new Promise((resolve) => {
    const state = {
      catalogue: [],
      filtered: [],
      activeIndex: 0,
      sortKey: 'name',
      query: '',
    };

    const overlay = document.createElement('div');
    overlay.className = 'model-picker-overlay';
    overlay.innerHTML = `
      <div class="model-picker" role="dialog" aria-label="Pick a model">
        <div class="model-picker-header">
          <span class="model-picker-title">${escapeHtml(opts.title || 'Choose model')}</span>
          <button class="model-picker-refresh icon-btn" title="Refresh model list" aria-label="Refresh">⟳</button>
          <button class="model-picker-close icon-btn" title="Close" aria-label="Close">×</button>
        </div>
        <div class="model-picker-search">
          <input type="text" class="model-picker-input" placeholder="Search models — try 'claude' or 'fast'…" autocomplete="off" spellcheck="false" />
        </div>
        <div class="model-picker-sortbar">
          <span class="model-picker-sortlabel">Sort:</span>
          ${SORT_OPTIONS.map(
            (s) =>
              `<button class="model-picker-sort" data-sort="${s.key}">${escapeHtml(s.label)}</button>`,
          ).join('')}
        </div>
        <div class="model-picker-list" role="listbox"></div>
        <div class="model-picker-footer">
          ${opts.allowUnset ? '<button class="model-picker-unset">Use default</button>' : ''}
          <span class="model-picker-hint">↑↓ navigate · Enter select · Esc close</span>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const input = overlay.querySelector('.model-picker-input');
    const listEl = overlay.querySelector('.model-picker-list');
    const sortButtons = Array.from(overlay.querySelectorAll('.model-picker-sort'));

    function close(value) {
      if (!overlay.isConnected) return;
      overlay.remove();
      document.removeEventListener('keydown', onKeyDown, true);
      if (currentInstance && currentInstance.overlay === overlay) currentInstance = null;
      resolve(value);
    }

    function cancel() {
      close(null);
    }

    currentInstance = { overlay, cancel };

    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) cancel();
    });
    overlay.querySelector('.model-picker-close').addEventListener('click', cancel);
    overlay.querySelector('.model-picker-refresh').addEventListener('click', async () => {
      clearCatalogueCache();
      await reloadCatalogue({ force: true });
    });
    if (opts.allowUnset) {
      overlay.querySelector('.model-picker-unset').addEventListener('click', () => close(null));
    }

    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        cancel();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveActive(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveActive(-1);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const picked = state.filtered[state.activeIndex];
        if (picked) close(picked.id);
      }
    }
    document.addEventListener('keydown', onKeyDown, true);

    input.addEventListener('input', () => {
      state.query = input.value.trim().toLowerCase();
      applyFilter();
    });

    sortButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        state.sortKey = btn.dataset.sort;
        updateSortButtons();
        applyFilter();
      });
    });
    updateSortButtons();

    listEl.addEventListener('click', (e) => {
      const row = e.target.closest('.model-picker-row');
      if (!row) return;
      const id = row.dataset.id;
      if (id) close(id);
    });

    listEl.addEventListener('mousemove', (e) => {
      const row = e.target.closest('.model-picker-row');
      if (!row) return;
      const idx = parseInt(row.dataset.idx, 10);
      if (Number.isFinite(idx) && idx !== state.activeIndex) {
        state.activeIndex = idx;
        updateActiveHighlight();
      }
    });

    function moveActive(delta) {
      if (!state.filtered.length) return;
      state.activeIndex =
        (state.activeIndex + delta + state.filtered.length) % state.filtered.length;
      updateActiveHighlight();
      ensureActiveVisible();
    }

    function updateActiveHighlight() {
      const rows = listEl.querySelectorAll('.model-picker-row');
      rows.forEach((row, i) => row.classList.toggle('active', i === state.activeIndex));
    }

    function ensureActiveVisible() {
      const active = listEl.querySelector('.model-picker-row.active');
      if (active) active.scrollIntoView({ block: 'nearest' });
    }

    function updateSortButtons() {
      sortButtons.forEach((b) => b.classList.toggle('active', b.dataset.sort === state.sortKey));
    }

    function applyFilter() {
      state.filtered = filterAndSort(state.catalogue, state.query, state.sortKey);
      // Keep selection close to the current model if visible; otherwise reset.
      if (opts.currentId) {
        const idx = state.filtered.findIndex((m) => m.id === opts.currentId);
        state.activeIndex = idx >= 0 ? idx : 0;
      } else {
        state.activeIndex = 0;
      }
      renderRows();
      updateActiveHighlight();
      ensureActiveVisible();
    }

    function renderRows() {
      if (!state.filtered.length) {
        listEl.innerHTML = '<div class="model-picker-empty">No models match.</div>';
        return;
      }
      const html = state.filtered
        .map((m, i) => {
          const ctx = formatContext(m.contextLength);
          const price = formatPrice(m.priceIn, m.priceOut);
          const vision = m.vision ? '<span class="model-picker-badge">vision</span>' : '';
          return `
            <div class="model-picker-row" role="option" data-id="${escapeHtml(m.id)}" data-idx="${i}">
              <div class="model-picker-row-main">
                <span class="model-picker-row-provider">${escapeHtml(m.provider || '')}</span>
                <span class="model-picker-row-name">${escapeHtml(stripProviderPrefix(m.name, m.provider))}</span>
                ${vision}
              </div>
              <div class="model-picker-row-meta">
                <span class="model-picker-ctx">${escapeHtml(ctx)}</span>
                <span class="model-picker-price">${escapeHtml(price)}</span>
              </div>
            </div>`;
        })
        .join('');
      listEl.innerHTML = html;
    }

    async function reloadCatalogue({ force = false } = {}) {
      listEl.innerHTML = '<div class="model-picker-empty">Loading…</div>';
      try {
        state.catalogue = await loadCatalogue({ force });
      } catch {
        state.catalogue = [];
      }
      applyFilter();
    }

    // Kick off
    reloadCatalogue();
    input.focus();
  });
}

// ── Pure helpers ─────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stripProviderPrefix(name, provider) {
  if (!name) return '';
  if (!provider) return name;
  // OpenRouter often prefixes display names with the provider, e.g.
  // "Anthropic: Claude Sonnet 4.5" — strip that so the row reads cleanly.
  const lower = name.toLowerCase();
  const provLower = provider.toLowerCase();
  const colonIdx = name.indexOf(':');
  if (colonIdx > 0 && lower.startsWith(provLower)) {
    return name.slice(colonIdx + 1).trim();
  }
  return name;
}

function formatContext(ctx) {
  if (!Number.isFinite(ctx) || ctx <= 0) return '—';
  if (ctx >= 1_000_000) return `${(ctx / 1_000_000).toFixed(ctx % 1_000_000 === 0 ? 0 : 1)}M`;
  if (ctx >= 1_000) return `${Math.round(ctx / 1_000)}k`;
  return String(ctx);
}

function formatPrice(pIn, pOut) {
  const fmt = (v) => {
    if (!Number.isFinite(v)) return '—';
    if (v === 0) return '0';
    if (v < 0.01) return v.toFixed(4);
    if (v < 1) return v.toFixed(3);
    return v.toFixed(2);
  };
  if (!Number.isFinite(pIn) && !Number.isFinite(pOut)) return '— / —';
  return `$${fmt(pIn)} / $${fmt(pOut)}`;
}

export function filterAndSort(catalogue, query, sortKey) {
  const list = (catalogue || []).slice();
  const q = (query || '').toLowerCase();

  const matches = q
    ? list.filter((m) => {
        const id = (m.id || '').toLowerCase();
        const name = (m.name || '').toLowerCase();
        const provider = (m.provider || '').toLowerCase();
        return id.includes(q) || name.includes(q) || provider.includes(q);
      })
    : list;

  const cmp = sorters[sortKey] || sorters.name;
  matches.sort(cmp);
  return matches;
}

const sorters = {
  name: (a, b) =>
    String(a.name || a.id).localeCompare(String(b.name || b.id), undefined, {
      sensitivity: 'base',
    }),
  provider: (a, b) => {
    const p = String(a.provider || '').localeCompare(String(b.provider || ''));
    if (p !== 0) return p;
    return sorters.name(a, b);
  },
  context: (a, b) => (b.contextLength || 0) - (a.contextLength || 0),
  // Sort cheapest first using the average of in/out price; fall back to whichever exists.
  price: (a, b) => {
    const ap = avgPrice(a);
    const bp = avgPrice(b);
    if (ap == null && bp == null) return 0;
    if (ap == null) return 1;
    if (bp == null) return -1;
    return ap - bp;
  },
};

function avgPrice(m) {
  const a = Number.isFinite(m.priceIn) ? m.priceIn : null;
  const b = Number.isFinite(m.priceOut) ? m.priceOut : null;
  if (a == null && b == null) return null;
  if (a == null) return b;
  if (b == null) return a;
  return (a + b) / 2;
}
