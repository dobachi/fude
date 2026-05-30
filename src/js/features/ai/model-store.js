// model-store.js - Central state and resolution for AI model selection.
//
// Two layers:
//   1. Catalogue cache: the full OpenRouter model list with metadata, cached
//      in localStorage with a 24h TTL so we don't refetch on every panel
//      open. busted on explicit refresh from the picker.
//   2. Effective-model resolution: each AI feature ("chat", "composer",
//      "inline") prefers its per-task setting, falls back to the global
//      default (`ai_model`), and finally to a hard-coded default.

import { aiModels, getConfig, saveConfig } from '../../backend.js';
import { DEFAULT_MODEL } from './openrouter-client.js';

const CACHE_KEY = 'fude.modelCatalogue';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Supported feature keys map to the config field that overrides the default. */
const FEATURE_CONFIG_FIELD = {
  chat: 'ai_model_chat',
  composer: 'ai_model_composer',
  inline: 'ai_model_inline',
};

const FALLBACK_MODELS = [
  {
    id: 'openai/gpt-4o-mini',
    name: 'GPT-4o Mini',
    provider: 'openai',
    contextLength: 128000,
    priceIn: 0.15,
    priceOut: 0.6,
    vision: true,
  },
  {
    id: 'openai/gpt-4o',
    name: 'GPT-4o',
    provider: 'openai',
    contextLength: 128000,
    priceIn: 5,
    priceOut: 15,
    vision: true,
  },
  {
    id: 'anthropic/claude-sonnet-4.5',
    name: 'Claude Sonnet 4.5',
    provider: 'anthropic',
    contextLength: 200000,
    priceIn: 3,
    priceOut: 15,
    vision: true,
  },
  {
    id: 'google/gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    provider: 'google',
    contextLength: 1_000_000,
    priceIn: 0.075,
    priceOut: 0.3,
    vision: true,
  },
];

/** In-memory mirror of the catalogue so repeat calls don't hit localStorage. */
let memCatalogue = null;

/**
 * Normalise an OpenRouter model record into the shape the picker uses.
 * Prices are in OpenRouter's $-per-token form; we convert to $/1M tokens
 * because that's how every vendor quotes them.
 */
function normaliseModel(raw) {
  if (!raw || !raw.id) return null;
  const id = String(raw.id);
  const slash = id.indexOf('/');
  const provider = slash > 0 ? id.slice(0, slash) : '';
  const priceIn = parseFloat(raw?.pricing?.prompt);
  const priceOut = parseFloat(raw?.pricing?.completion);
  const ctx = parseInt(raw?.context_length, 10);
  const modality = raw?.architecture?.modality || '';
  return {
    id,
    name: raw.name || id,
    provider,
    contextLength: Number.isFinite(ctx) ? ctx : null,
    priceIn: Number.isFinite(priceIn) ? priceIn * 1_000_000 : null, // $ per 1M
    priceOut: Number.isFinite(priceOut) ? priceOut * 1_000_000 : null,
    vision: typeof modality === 'string' && /image|vision/i.test(modality),
  };
}

function loadCatalogueFromStorage() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.data) || typeof parsed.fetchedAt !== 'number') return null;
    if (Date.now() - parsed.fetchedAt > CACHE_TTL_MS) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function saveCatalogueToStorage(data) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ data, fetchedAt: Date.now() }));
  } catch {
    /* quota exceeded or private mode — fine, in-memory cache still works */
  }
}

/**
 * Fetch the full model catalogue. Uses cached data unless `force` is true.
 * Returns FALLBACK_MODELS on network or backend failure so the picker is
 * still usable offline.
 */
export async function loadCatalogue({ force = false } = {}) {
  if (!force) {
    if (memCatalogue) return memCatalogue;
    const cached = loadCatalogueFromStorage();
    if (cached && cached.length) {
      memCatalogue = cached;
      return memCatalogue;
    }
  }

  try {
    const data = await aiModels();
    const raw = Array.isArray(data?.data) ? data.data : [];
    const models = raw.map(normaliseModel).filter(Boolean);
    if (models.length) {
      memCatalogue = models;
      saveCatalogueToStorage(models);
      return memCatalogue;
    }
  } catch {
    /* fall through to fallback */
  }

  memCatalogue = FALLBACK_MODELS;
  return memCatalogue;
}

/** Drop both caches; the next loadCatalogue call will refetch. */
export function clearCatalogueCache() {
  memCatalogue = null;
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Best-effort lookup of one model in the catalogue. Returns a minimal
 * placeholder so the UI can always show the id even if metadata is missing.
 */
export function findModelById(catalogue, id) {
  if (!id) return null;
  return (
    (catalogue || []).find((m) => m.id === id) || {
      id,
      name: id,
      provider: id.includes('/') ? id.split('/')[0] : '',
      contextLength: null,
      priceIn: null,
      priceOut: null,
      vision: false,
    }
  );
}

/**
 * Resolve the effective model id for a given feature. Order:
 *   1. config[FEATURE_CONFIG_FIELD[feature]]
 *   2. config.ai_model
 *   3. DEFAULT_MODEL (hardcoded)
 */
export function resolveModel(config, feature) {
  const field = FEATURE_CONFIG_FIELD[feature];
  if (field && config && typeof config[field] === 'string' && config[field]) return config[field];
  if (config && typeof config.ai_model === 'string' && config.ai_model) return config.ai_model;
  return DEFAULT_MODEL;
}

/**
 * Persist a model id either for a specific feature or as the global default
 * (`feature` omitted / 'default'). Passing null clears the per-task override
 * so the feature falls back to the default again.
 */
export async function persistModelChoice(feature, modelId) {
  let config;
  try {
    config = await getConfig();
  } catch {
    config = {};
  }
  if (!feature || feature === 'default') {
    config.ai_model = modelId || null;
  } else {
    const field = FEATURE_CONFIG_FIELD[feature];
    if (!field) throw new Error(`Unknown feature: ${feature}`);
    config[field] = modelId || null;
  }
  await saveConfig(config);
}

export { FEATURE_CONFIG_FIELD };
