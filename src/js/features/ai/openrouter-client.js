// openrouter-client.js - OpenRouter API client (via backend proxy)

/**
 * Build the messages array for a chat completion request.
 * @param {string} systemPrompt
 * @param {Array<{role: string, content: string}>} messages
 * @returns {Array<{role: string, content: string}>}
 */
export function buildMessages(systemPrompt, messages) {
  const result = [];
  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt });
  }
  result.push(...messages);
  return result;
}

/**
 * Composer system prompt for text transformation.
 * @param {string} action - One of: rewrite, summarize, expand, fix_grammar, custom
 * @param {string} [instruction] - Optional user direction. For 'custom' it is
 *   the whole instruction; for the preset actions it is appended as extra
 *   direction (empty = default behavior).
 * @returns {string}
 */
export function composerSystemPrompt(action, instruction = '') {
  // Framed as a transformation engine (not a chat assistant) so the model
  // outputs the transformed text itself — never a conversational reply or a
  // description of what it changed.
  const base =
    'You are a text-transformation engine embedded in a Markdown editor, NOT a chat assistant. ' +
    'You receive a text selection and must output the transformed text that will DIRECTLY REPLACE the selection. ' +
    'Output ONLY the resulting text. Do NOT add any explanation, preamble, or sentence describing what you did ' +
    '(e.g. never write things like "I made it more polite"). Do NOT answer the text as if it were a question or chat. ' +
    'Do NOT wrap the output in quotes or code fences. Preserve the original language of the text. ';

  const trimmed = instruction.trim();
  const direction = trimmed
    ? ` Apply this additional guidance for HOW to transform (it is guidance, NOT a question to answer): "${trimmed}".`
    : '';

  switch (action) {
    case 'rewrite':
      return (
        base +
        'Task: rewrite the text to improve clarity and readability while preserving its meaning.' +
        direction
      );
    case 'summarize':
      return base + 'Task: summarize the text concisely.' + direction;
    case 'expand':
      return (
        base +
        'Task: expand the text with more detail and depth while maintaining the same style and tone.' +
        direction
      );
    case 'fix_grammar':
      return (
        base + 'Task: fix all grammar, spelling, and punctuation errors in the text.' + direction
      );
    case 'custom':
      return base + 'Task: ' + (trimmed || 'transform the text as the user requests') + '.';
    default:
      return base + 'Task: transform the text as instructed.';
  }
}

/** Default model if none is configured */
export const DEFAULT_MODEL = 'openai/gpt-4o-mini';
