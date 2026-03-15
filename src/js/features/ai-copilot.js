// ai-copilot.js - AI Copilot orchestrator (dynamic import)
// Only loads AI modules when the feature is enabled in config.

let composerModule = null;
let chatModule = null;
let inlineExtension = null;

export async function initAICopilot(config) {
  if (!config?.features?.ai_copilot) {
    console.info('AI Copilot: disabled');
    return;
  }

  if (!config.openrouter_api_key) {
    console.info('AI Copilot: no API key configured');
    return;
  }

  console.info('AI Copilot: enabled');
}

/**
 * Open the Composer popup for the given editor view.
 */
export async function openComposerForView(view) {
  if (!composerModule) {
    composerModule = await import('./ai/composer.js');
  }
  composerModule.openComposer(view);
}

/**
 * Initialize the AI Chat panel.
 * @param {HTMLElement} containerEl
 * @param {{ getVaultPath: () => string, getActiveView: () => any }} opts
 */
export async function initChatPanel(containerEl, opts) {
  if (!chatModule) {
    chatModule = await import('./ai/chat.js');
  }
  chatModule.initChat(containerEl, opts);
}

/**
 * Get the inline completion CodeMirror extension.
 * Returns the extension array, or empty array if not available.
 */
export async function getInlineCompletionExtension() {
  if (inlineExtension) return inlineExtension;
  try {
    const mod = await import('./ai/inline-completion.js');
    inlineExtension = mod.inlineCompletionExtension();
    return inlineExtension;
  } catch (e) {
    console.warn('Inline completion not available:', e);
    return [];
  }
}

/**
 * Toggle the AI panel visibility.
 */
export function toggleAIPanel() {
  const app = document.getElementById('app');
  if (!app) return;
  app.classList.toggle('ai-panel-open');
}

export function enableCopilot() {}
export function disableCopilot() {}
