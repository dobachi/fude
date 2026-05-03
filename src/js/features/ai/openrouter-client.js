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
 * @param {string} [customInstruction] - Only used when action is 'custom'
 * @returns {string}
 */
export function composerSystemPrompt(action, customInstruction = '') {
  const base =
    'You are a helpful writing assistant. You will be given a text selection from a Markdown document. ';

  switch (action) {
    case 'rewrite':
      return (
        base +
        'Rewrite the text to improve clarity and readability while preserving the meaning. Return ONLY the rewritten text, no explanations.'
      );
    case 'summarize':
      return base + 'Summarize the text concisely. Return ONLY the summary, no explanations.';
    case 'expand':
      return (
        base +
        'Expand the text with more detail and depth while maintaining the same style and tone. Return ONLY the expanded text, no explanations.'
      );
    case 'fix_grammar':
      return (
        base +
        'Fix all grammar, spelling, and punctuation errors in the text. Return ONLY the corrected text, no explanations.'
      );
    case 'custom':
      return (
        base +
        (customInstruction ||
          "Follow the user's instruction. Return ONLY the result, no explanations.")
      );
    default:
      return base + "Follow the user's instruction. Return ONLY the result, no explanations.";
  }
}

/** Default model if none is configured */
export const DEFAULT_MODEL = 'openai/gpt-4o-mini';
