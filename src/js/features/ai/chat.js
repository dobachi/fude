// chat.js - AI Chat panel UI
import { aiChatStream, getConfig, saveConfig } from '../../backend.js';
import { buildMessages, DEFAULT_MODEL } from './openrouter-client.js';
import { createModelPicker } from './model-picker.js';
import { saveChatHistory } from './chat-history.js';
import { getEditorContext } from './context.js';
import markdownit from 'markdown-it';

const md = markdownit({ html: false, linkify: true, breaks: true });

let chatMessages = [];
let currentModel = DEFAULT_MODEL;
let activeAbort = null;
let panelContentEl = null;
let getVaultPath = null;
let getActiveView = null;
let currentSelectedText = '';
let includeDocContext = true;
let currentDocPath = '';
let currentDocContent = '';

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

/**
 * Update the selected text context shown in the chat panel.
 * Called externally when the editor selection changes.
 * @param {string} text - The currently selected text (empty string if no selection)
 */
export function updateSelectedContext(text) {
  currentSelectedText = text;
  const bar = panelContentEl?.querySelector('.ai-chat-context-bar');
  if (!bar) return;
  if (text) {
    bar.querySelector('.ai-chat-context-text').textContent = text;
    bar.classList.remove('hidden');
  } else {
    bar.classList.add('hidden');
  }
}

/**
 * Update the document context (file path and content).
 * Called externally when tabs change or content is edited.
 * @param {string} filePath
 * @param {string} content
 */
export function updateDocContext(filePath, content) {
  currentDocPath = filePath || '';
  currentDocContent = content || '';
  renderDocInfo();
}

function renderDocInfo() {
  const info = panelContentEl?.querySelector('.ai-chat-doc-info');
  if (!info) return;
  if (includeDocContext && currentDocPath) {
    const fileName = currentDocPath.split('/').pop();
    info.textContent = '\u{1F4C4} ' + fileName;
    info.classList.remove('hidden');
  } else {
    info.classList.add('hidden');
  }
}

function renderChatUI() {
  if (!panelContentEl) return;

  panelContentEl.innerHTML = `
    <div class="ai-chat-model-bar"></div>
    <div class="ai-chat-doc-info hidden"></div>
    <div class="ai-chat-context-bar hidden">
      <div class="ai-chat-context-label">Selection</div>
      <div class="ai-chat-context-text"></div>
    </div>
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

  // Restore selected context if already set
  if (currentSelectedText) {
    updateSelectedContext(currentSelectedText);
  }

  // Restore doc info if already set
  renderDocInfo();

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

  // Doc context toggle button
  const docToggle = document.createElement('button');
  docToggle.className = 'ai-chat-doc-toggle active';
  docToggle.textContent = 'Doc';
  docToggle.title = 'Include full document as context';
  docToggle.addEventListener('click', () => {
    includeDocContext = !includeDocContext;
    docToggle.classList.toggle('active', includeDocContext);
    renderDocInfo();
  });
  container.appendChild(docToggle);

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

function createCopyButton(rawContent) {
  const btn = document.createElement('button');
  btn.className = 'ai-msg-copy';
  btn.textContent = 'Copy';
  btn.title = 'Copy to clipboard';
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(rawContent);
    } catch {
      // fallback
      const ta = document.createElement('textarea');
      ta.value = rawContent;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  });
  return btn;
}

function renderMessages(container) {
  if (!container) return;
  container.innerHTML = '';

  for (const msg of chatMessages) {
    if (msg.role === 'system') continue;
    const wrapper = document.createElement('div');
    wrapper.className = `ai-msg ${msg.role}`;
    if (msg.role === 'assistant') {
      wrapper.innerHTML = md.render(msg.content);
      wrapper.appendChild(createCopyButton(msg.content));
    } else {
      wrapper.textContent = msg.content;
    }
    container.appendChild(wrapper);
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

  // Add selected text context
  if (currentSelectedText) {
    systemPrompt += `\n\nThe user has selected the following text in the editor:\n\`\`\`\n${currentSelectedText}\n\`\`\``;
  }

  // Add full document context if enabled
  if (includeDocContext && currentDocContent) {
    systemPrompt += `\n\nThe user is editing the following document:\n\`\`\`markdown\n${currentDocContent}\n\`\`\``;
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
  let renderTimer = null;

  const renderStreaming = () => {
    assistantDiv.innerHTML = md.render(result);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  };

  try {
    await aiChatStream(
      messages,
      currentModel,
      (chunk) => {
        result += chunk;
        // Debounced markdown rendering during streaming
        if (!renderTimer) {
          renderTimer = setTimeout(() => {
            renderTimer = null;
            renderStreaming();
          }, 100);
        }
      },
      () => {
        // Final render
        if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
        renderStreaming();
        assistantDiv.appendChild(createCopyButton(result));
        chatMessages.push({ role: 'assistant', content: result });
        // Auto-save chat history
        const vault = getVaultPath?.();
        if (vault) {
          saveChatHistory(vault, chatMessages, currentModel).catch(() => {});
        }
      },
      (err) => {
        if (err.name === 'AbortError') return;
        if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
        assistantDiv.textContent = `Error: ${err.message}`;
        assistantDiv.classList.add('ai-msg-error');
      },
      activeAbort.signal,
    );
  } catch (err) {
    if (err.name !== 'AbortError') {
      if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
      assistantDiv.textContent = `Error: ${err.message}`;
      assistantDiv.classList.add('ai-msg-error');
    }
  }
}

export function clearChat() {
  chatMessages = [];
}
