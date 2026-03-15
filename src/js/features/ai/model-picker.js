// model-picker.js - OpenRouter model selection
import { aiModels } from '../../backend.js';

const FALLBACK_MODELS = [
  { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini' },
  { id: 'openai/gpt-4o', name: 'GPT-4o' },
  { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4' },
  { id: 'google/gemini-2.5-flash-preview', name: 'Gemini 2.5 Flash' },
];

let cachedModels = null;

/**
 * Fetch available models from OpenRouter (cached).
 * Falls back to a hardcoded list if the API call fails.
 */
export async function getModels() {
  if (cachedModels) return cachedModels;

  try {
    const data = await aiModels();
    if (data && data.data && data.data.length > 0) {
      cachedModels = data.data
        .filter((m) => m.id)
        .slice(0, 50)
        .map((m) => ({ id: m.id, name: m.name || m.id }));
      return cachedModels;
    }
  } catch {
    // ignore
  }

  cachedModels = FALLBACK_MODELS;
  return cachedModels;
}

/**
 * Create a model picker <select> element.
 * @param {string} currentModel - Currently selected model id
 * @param {(modelId: string) => void} onChange
 * @returns {HTMLSelectElement}
 */
export async function createModelPicker(currentModel, onChange) {
  const models = await getModels();
  const select = document.createElement('select');
  select.className = 'ai-model-select';

  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name;
    if (m.id === currentModel) opt.selected = true;
    select.appendChild(opt);
  }

  // If current model not in list, add it
  if (currentModel && !models.find((m) => m.id === currentModel)) {
    const opt = document.createElement('option');
    opt.value = currentModel;
    opt.textContent = currentModel;
    opt.selected = true;
    select.prepend(opt);
  }

  select.addEventListener('change', () => onChange(select.value));
  return select;
}

export function clearModelCache() {
  cachedModels = null;
}
