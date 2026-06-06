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
  const base =
    'You are a helpful writing assistant. You will be given a text selection from a Markdown document. ';
  const trimmed = instruction.trim();
  const direction = trimmed
    ? ` Additionally, follow this instruction from the user: "${trimmed}".`
    : '';

  switch (action) {
    case 'rewrite':
      return (
        base +
        'Rewrite the text to improve clarity and readability while preserving the meaning.' +
        direction +
        ' Return ONLY the rewritten text, no explanations.'
      );
    case 'summarize':
      return (
        base +
        'Summarize the text concisely.' +
        direction +
        ' Return ONLY the summary, no explanations.'
      );
    case 'expand':
      return (
        base +
        'Expand the text with more detail and depth while maintaining the same style and tone.' +
        direction +
        ' Return ONLY the expanded text, no explanations.'
      );
    case 'fix_grammar':
      return (
        base +
        'Fix all grammar, spelling, and punctuation errors in the text.' +
        direction +
        ' Return ONLY the corrected text, no explanations.'
      );
    case 'custom':
      return (
        base +
        (trimmed || "Follow the user's instruction.") +
        ' Return ONLY the result, no explanations.'
      );
    default:
      return base + "Follow the user's instruction. Return ONLY the result, no explanations.";
  }
}

/** Default model if none is configured */
export const DEFAULT_MODEL = 'openai/gpt-4o-mini';
