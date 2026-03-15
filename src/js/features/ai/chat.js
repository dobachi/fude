// chat.js - AI Chat panel UI
import { aiChatStream, getConfig, saveConfig } from '../../backend.js';
import { buildMessages, DEFAULT_MODEL } from './openrouter-client.js';
import { createModelPicker } from './model-picker.js';
import { saveChatHistory } from './chat-history.js';
import { getEditorContext } from './context.js';

let chatMessages = [];
let currentModel = DEFAULT_MODEL;
let activeAbort = null;
let panelContentEl = null;
let getVaultPath = null;
let getActiveView = null;

/**
 * Initialize the chat panel.
 * @param {HTMLElement} containerEl - #ai-panel-content element
 * @param {{ getVaultPath: () => string, getActiveView: () => any }} opts
 */
export async function initChat(containerEl, opts) {
  panelContentEl = containerEl;
  getVaultPath = opts.getVaultPath;
  getActiveView = opts.getActiveView;

  let config;
  try {
    config = await getConfig();
  } catch {
    config = {};
  }
  currentModel = config.ai_model || DEFAULT_MODEL;

  renderChatUI();
}

function renderChatUI() {
  if (!panelContentEl) return;

  panelContentEl.innerHTML = `
    <div class="ai-chat-model-bar"></div>
    <div class="ai-chat-messages"></div>
    <div class="ai-chat-input-bar">
      <textarea class="ai-chat-textarea" placeholder="Ask about your document..." rows="2"></textarea>
      <button class="ai-chat-send">Send</button>
    </div>
  `;

  const modelBar = panelContentEl.querySelector('.ai-chat-model-bar');
  const messagesEl = panelContentEl.querySelector('.ai-chat-messages');
  const textarea = panelContentEl.querySelector('.ai-chat-textarea');
  const sendBtn = panelContentEl.querySelector('.ai-chat-send');

  // Model picker
  setupModelBar(modelBar);

  // Send message
  const send = () => {
    const text = textarea.value.trim();
    if (!text) return;
    textarea.value = '';
    textarea.style.height = 'auto';
    sendMessage(text, messagesEl);
  };

  sendBtn.addEventListener('click', send);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  // Auto-resize textarea
  textarea.addEventListener('input', () => {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
  });

  renderMessages(messagesEl);
}

async function setupModelBar(container) {
  container.innerHTML = '';

  const picker = await createModelPicker(currentModel, async (modelId) => {
    currentModel = modelId;
    // Persist model choice
    try {
      const config = await getConfig();
      config.ai_model = modelId;
      await saveConfig(config);
    } catch { /* ignore */ }
  });
  container.appendChild(picker);

  const newChatBtn = document.createElement('button');
  newChatBtn.className = 'ai-chat-new';
  newChatBtn.textContent = 'New';
  newChatBtn.title = 'New chat';
  newChatBtn.addEventListener('click', () => {
    chatMessages = [];
    const messagesEl = panelContentEl?.querySelector('.ai-chat-messages');
    if (messagesEl) renderMessages(messagesEl);
  });
  container.appendChild(newChatBtn);
}

function renderMessages(container) {
  if (!container) return;
  container.innerHTML = '';

  for (const msg of chatMessages) {
    if (msg.role === 'system') continue;
    const div = document.createElement('div');
    div.className = `ai-msg ${msg.role}`;
    div.textContent = msg.content;
    container.appendChild(div);
  }

  container.scrollTop = container.scrollHeight;
}

async function sendMessage(text, messagesEl) {
  if (activeAbort) activeAbort.abort();
  activeAbort = new AbortController();

  // Add user message
  chatMessages.push({ role: 'user', content: text });

  // Build context from current editor
  let systemPrompt = 'You are a helpful writing assistant for a Markdown editor called Fude.';
  const view = getActiveView?.();
  if (view) {
    const ctx = getEditorContext(view);
    if (ctx.fullContent) {
      systemPrompt += `\n\nThe user is editing the following document:\n\`\`\`markdown\n${ctx.fullContent.slice(0, 4000)}\n\`\`\``;
    }
  }

  const messages = buildMessages(systemPrompt, chatMessages);

  // Render current state
  renderMessages(messagesEl);

  // Add streaming assistant placeholder
  const assistantDiv = document.createElement('div');
  assistantDiv.className = 'ai-msg assistant';
  assistantDiv.textContent = '';
  messagesEl.appendChild(assistantDiv);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  let result = '';

  try {
    await aiChatStream(
      messages,
      currentModel,
      (chunk) => {
        result += chunk;
        assistantDiv.textContent = result;
        messagesEl.scrollTop = messagesEl.scrollHeight;
      },
      () => {
        chatMessages.push({ role: 'assistant', content: result });
        // Auto-save chat history
        const vault = getVaultPath?.();
        if (vault) {
          saveChatHistory(vault, chatMessages, currentModel).catch(() => {});
        }
      },
      (err) => {
        if (err.name === 'AbortError') return;
        assistantDiv.textContent = `Error: ${err.message}`;
        assistantDiv.classList.add('ai-msg-error');
      },
      activeAbort.signal,
    );
  } catch (err) {
    if (err.name !== 'AbortError') {
      assistantDiv.textContent = `Error: ${err.message}`;
      assistantDiv.classList.add('ai-msg-error');
    }
  }
}

export function clearChat() {
  chatMessages = [];
}
