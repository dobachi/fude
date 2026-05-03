// chat-history.js - Save/load chat history as .md files
import { writeFile, readFile, readDirTree } from '../../backend.js';

const CHAT_DIR_NAME = '.fude-chat';

/**
 * Get the chat directory path for the current vault.
 * @param {string} vaultPath
 * @returns {string}
 */
function chatDir(vaultPath) {
  return `${vaultPath}/${CHAT_DIR_NAME}`;
}

/**
 * Save a chat conversation as a markdown file.
 * @param {string} vaultPath
 * @param {Array<{role: string, content: string}>} messages
 * @param {string} model
 */
export async function saveChatHistory(vaultPath, messages, model) {
  if (!vaultPath) return;

  const now = new Date();
  const timestamp = now.toISOString().replace(/[T]/g, '-').replace(/[:]/g, '').slice(0, 15);

  const fileName = `${timestamp}.md`;
  const filePath = `${chatDir(vaultPath)}/${fileName}`;

  let md = `# Chat - ${now.toLocaleString()}\n`;
  md += `Model: ${model}\n\n---\n\n`;

  for (const msg of messages) {
    if (msg.role === 'system') continue;
    const prefix = msg.role === 'user' ? '**User**' : '**Assistant**';
    md += `${prefix}:\n\n${msg.content}\n\n---\n\n`;
  }

  await writeFile(filePath, md);
}

/**
 * Load recent chat history files from the vault.
 * @param {string} vaultPath
 * @returns {Promise<Array<{path: string, name: string}>>}
 */
export async function listChatHistory(vaultPath) {
  if (!vaultPath) return [];

  try {
    const tree = await readDirTree(chatDir(vaultPath));
    return tree
      .filter((f) => !f.is_dir && f.name.endsWith('.md'))
      .map((f) => ({ path: f.path, name: f.name }))
      .reverse(); // newest first
  } catch {
    return [];
  }
}

/**
 * Load a specific chat file and parse messages from it.
 * @param {string} filePath
 * @returns {Promise<Array<{role: string, content: string}>>}
 */
export async function loadChatFile(filePath) {
  try {
    const content = await readFile(filePath);
    const messages = [];
    const sections = content.split(/\n---\n/);

    for (const section of sections.slice(1)) {
      const trimmed = section.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('**User**:')) {
        messages.push({
          role: 'user',
          content: trimmed.replace(/^\*\*User\*\*:\s*\n*/, '').trim(),
        });
      } else if (trimmed.startsWith('**Assistant**:')) {
        messages.push({
          role: 'assistant',
          content: trimmed.replace(/^\*\*Assistant\*\*:\s*\n*/, '').trim(),
        });
      }
    }

    return messages;
  } catch {
    return [];
  }
}
