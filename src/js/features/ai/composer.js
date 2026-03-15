// composer.js - Composer UI: floating popup for AI text transformation
import { aiChatStream } from '../../backend.js';
import { buildMessages, composerSystemPrompt, DEFAULT_MODEL } from './openrouter-client.js';
import { getEditorContext } from './context.js';
import { getConfig } from '../../backend.js';

let composerEl = null;
let activeAbort = null;

const ACTIONS = [
  { id: 'rewrite', label: 'Rewrite', icon: '✏' },
  { id: 'summarize', label: 'Summarize', icon: '📝' },
  { id: 'expand', label: 'Expand', icon: '📖' },
  { id: 'fix_grammar', label: 'Fix Grammar', icon: '✓' },
  { id: 'custom', label: 'Custom...', icon: '⚙' },
];

/**
 * Open the Composer popup near the current selection.
 * @param {import('@codemirror/view').EditorView} view - The active editor view
 */
export function openComposer(view) {
  if (composerEl) closeComposer();

  const ctx = getEditorContext(view);
  if (!ctx.selectedText) return;

  // Get selection screen coordinates
  const coords = view.coordsAtPos(ctx.selectionFrom);
  if (!coords) return;

  composerEl = document.createElement('div');
  composerEl.className = 'ai-composer';
  composerEl.innerHTML = buildActionMenu();

  document.body.appendChild(composerEl);

  // Position near selection
  const rect = composerEl.getBoundingClientRect();
  let top = coords.bottom + 8;
  let left = coords.left;

  // Keep within viewport
  if (top + rect.height > window.innerHeight) {
    top = coords.top - rect.height - 8;
  }
  if (left + rect.width > window.innerWidth) {
    left = window.innerWidth - rect.width - 8;
  }
  left = Math.max(8, left);

  composerEl.style.top = `${top}px`;
  composerEl.style.left = `${left}px`;

  // Action button handlers
  composerEl.querySelectorAll('.ai-composer-action').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      if (action === 'custom') {
        showCustomInput(view, ctx);
      } else {
        executeAction(view, ctx, action);
      }
    });
  });

  // Close on Escape or click outside
  const closeHandler = (e) => {
    if (e.key === 'Escape') {
      closeComposer();
      document.removeEventListener('keydown', closeHandler);
    }
  };
  document.addEventListener('keydown', closeHandler);

  const clickOutside = (e) => {
    if (composerEl && !composerEl.contains(e.target)) {
      closeComposer();
      document.removeEventListener('mousedown', clickOutside);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', clickOutside), 0);
}

function buildActionMenu() {
  const items = ACTIONS.map(
    (a) => `<button class="ai-composer-action" data-action="${a.id}"><span class="ai-composer-icon">${a.icon}</span>${a.label}</button>`,
  ).join('');
  return `<div class="ai-composer-menu">${items}</div>`;
}

function showCustomInput(view, ctx) {
  if (!composerEl) return;
  composerEl.innerHTML = `
    <div class="ai-composer-custom">
      <input type="text" class="ai-composer-custom-input" placeholder="Describe what to do..." autofocus />
      <button class="ai-composer-custom-go">Go</button>
    </div>
  `;
  const input = composerEl.querySelector('.ai-composer-custom-input');
  const goBtn = composerEl.querySelector('.ai-composer-custom-go');

  const run = () => {
    const instruction = input.value.trim();
    if (instruction) executeAction(view, ctx, 'custom', instruction);
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); run(); }
  });
  goBtn.addEventListener('click', run);
  input.focus();
}

async function executeAction(view, ctx, action, customInstruction = '') {
  if (!composerEl) return;

  // Cancel any previous request
  if (activeAbort) activeAbort.abort();
  activeAbort = new AbortController();

  let config;
  try {
    config = await getConfig();
  } catch {
    config = {};
  }

  const model = config.ai_model || DEFAULT_MODEL;
  const systemPrompt = composerSystemPrompt(action, customInstruction);
  const messages = buildMessages(systemPrompt, [
    { role: 'user', content: ctx.selectedText },
  ]);

  // Show streaming result
  composerEl.innerHTML = `
    <div class="ai-composer-result">
      <div class="ai-composer-streaming"></div>
      <div class="ai-composer-actions-bar" style="display:none">
        <button class="ai-composer-accept">Accept</button>
        <button class="ai-composer-reject">Reject</button>
      </div>
    </div>
  `;

  const streamingEl = composerEl.querySelector('.ai-composer-streaming');
  const actionsBar = composerEl.querySelector('.ai-composer-actions-bar');
  let result = '';

  try {
    await aiChatStream(
      messages,
      model,
      (chunk) => {
        result += chunk;
        streamingEl.textContent = result;
        // Auto-scroll
        streamingEl.scrollTop = streamingEl.scrollHeight;
      },
      () => {
        // Done
        actionsBar.style.display = '';
        showDiff(composerEl, ctx.selectedText, result);
        setupAcceptReject(composerEl, view, ctx, result);
      },
      (err) => {
        if (err.name === 'AbortError') return;
        streamingEl.textContent = `Error: ${err.message}`;
        streamingEl.classList.add('ai-composer-error');
      },
      activeAbort.signal,
    );
  } catch (err) {
    if (err.name !== 'AbortError') {
      streamingEl.textContent = `Error: ${err.message}`;
      streamingEl.classList.add('ai-composer-error');
    }
  }
}

function showDiff(container, original, modified) {
  const streamingEl = container.querySelector('.ai-composer-streaming');
  if (!streamingEl) return;

  const origLines = original.split('\n');
  const modLines = modified.split('\n');

  let diffHtml = '<div class="ai-composer-diff">';

  // Simple line-level diff
  const maxLen = Math.max(origLines.length, modLines.length);
  for (let i = 0; i < maxLen; i++) {
    const orig = origLines[i];
    const mod = modLines[i];

    if (orig === undefined) {
      diffHtml += `<div class="diff-added">+ ${escapeHtml(mod)}</div>`;
    } else if (mod === undefined) {
      diffHtml += `<div class="diff-removed">- ${escapeHtml(orig)}</div>`;
    } else if (orig !== mod) {
      diffHtml += `<div class="diff-removed">- ${escapeHtml(orig)}</div>`;
      diffHtml += `<div class="diff-added">+ ${escapeHtml(mod)}</div>`;
    } else {
      diffHtml += `<div class="diff-unchanged">  ${escapeHtml(orig)}</div>`;
    }
  }

  diffHtml += '</div>';
  streamingEl.innerHTML = diffHtml;
}

function setupAcceptReject(container, view, ctx, result) {
  const acceptBtn = container.querySelector('.ai-composer-accept');
  const rejectBtn = container.querySelector('.ai-composer-reject');

  if (acceptBtn) {
    acceptBtn.addEventListener('click', () => {
      // Replace selected text with AI result
      view.dispatch({
        changes: { from: ctx.selectionFrom, to: ctx.selectionTo, insert: result },
      });
      closeComposer();
      view.focus();
    });
  }

  if (rejectBtn) {
    rejectBtn.addEventListener('click', () => {
      closeComposer();
      view.focus();
    });
  }
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Execute a composer action directly without showing the action menu.
 * Used by context-menu to skip the redundant menu.
 * @param {import('@codemirror/view').EditorView} view
 * @param {string} action - Action id (rewrite, summarize, expand, fix_grammar)
 */
export function executeActionDirect(view, action) {
  if (composerEl) closeComposer();

  const ctx = getEditorContext(view);
  if (!ctx.selectedText) return;

  // Get selection screen coordinates for positioning
  const coords = view.coordsAtPos(ctx.selectionFrom);
  if (!coords) return;

  composerEl = document.createElement('div');
  composerEl.className = 'ai-composer';
  document.body.appendChild(composerEl);

  // Position near selection
  let top = coords.bottom + 8;
  let left = coords.left;
  composerEl.style.top = `${top}px`;
  composerEl.style.left = `${left}px`;

  // Close on Escape or click outside
  const closeHandler = (e) => {
    if (e.key === 'Escape') {
      closeComposer();
      document.removeEventListener('keydown', closeHandler);
    }
  };
  document.addEventListener('keydown', closeHandler);

  const clickOutside = (e) => {
    if (composerEl && !composerEl.contains(e.target)) {
      closeComposer();
      document.removeEventListener('mousedown', clickOutside);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', clickOutside), 0);

  executeAction(view, ctx, action);
}

export function closeComposer() {
  if (activeAbort) {
    activeAbort.abort();
    activeAbort = null;
  }
  if (composerEl) {
    composerEl.remove();
    composerEl = null;
  }
}
