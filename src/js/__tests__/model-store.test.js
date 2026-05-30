import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../backend.js', () => ({
  aiModels: vi.fn(),
  getConfig: vi.fn(),
  saveConfig: vi.fn(),
}));

import { aiModels, getConfig, saveConfig } from '../backend.js';
import {
  resolveModel,
  findModelById,
  loadCatalogue,
  clearCatalogueCache,
  persistModelChoice,
} from '../features/ai/model-store.js';
import { DEFAULT_MODEL } from '../features/ai/openrouter-client.js';

describe('resolveModel', () => {
  it('prefers per-task override over global default', () => {
    const cfg = { ai_model: 'openai/gpt-4o', ai_model_chat: 'anthropic/claude-sonnet-4.5' };
    expect(resolveModel(cfg, 'chat')).toBe('anthropic/claude-sonnet-4.5');
  });

  it('falls back to ai_model when per-task is missing', () => {
    const cfg = { ai_model: 'openai/gpt-4o' };
    expect(resolveModel(cfg, 'chat')).toBe('openai/gpt-4o');
    expect(resolveModel(cfg, 'composer')).toBe('openai/gpt-4o');
    expect(resolveModel(cfg, 'inline')).toBe('openai/gpt-4o');
  });

  it('falls back to hardcoded DEFAULT_MODEL when nothing is configured', () => {
    expect(resolveModel({}, 'chat')).toBe(DEFAULT_MODEL);
    expect(resolveModel(null, 'composer')).toBe(DEFAULT_MODEL);
    expect(resolveModel(undefined, 'inline')).toBe(DEFAULT_MODEL);
  });

  it('treats empty string per-task fields as unset', () => {
    const cfg = { ai_model: 'openai/gpt-4o', ai_model_chat: '' };
    expect(resolveModel(cfg, 'chat')).toBe('openai/gpt-4o');
  });
});

describe('findModelById', () => {
  it('returns the matching model from the catalogue', () => {
    const cat = [
      { id: 'openai/gpt-4o', name: 'GPT-4o', provider: 'openai' },
      { id: 'anthropic/claude', name: 'Claude', provider: 'anthropic' },
    ];
    expect(findModelById(cat, 'openai/gpt-4o').name).toBe('GPT-4o');
  });

  it('returns a placeholder with the id when the model is unknown', () => {
    const m = findModelById([], 'foo/bar');
    expect(m.id).toBe('foo/bar');
    expect(m.name).toBe('foo/bar');
    expect(m.provider).toBe('foo');
  });

  it('returns null for falsy id', () => {
    expect(findModelById([], '')).toBeNull();
    expect(findModelById([], null)).toBeNull();
  });
});

describe('loadCatalogue', () => {
  beforeEach(() => {
    clearCatalogueCache();
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('normalises raw OpenRouter records into the picker shape', async () => {
    aiModels.mockResolvedValue({
      data: [
        {
          id: 'anthropic/claude-sonnet-4.5',
          name: 'Anthropic: Claude Sonnet 4.5',
          context_length: 200000,
          pricing: { prompt: '0.000003', completion: '0.000015' },
          architecture: { modality: 'text+image->text' },
        },
      ],
    });
    const models = await loadCatalogue({ force: true });
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: 'anthropic/claude-sonnet-4.5',
      provider: 'anthropic',
      contextLength: 200000,
      vision: true,
    });
    expect(models[0].priceIn).toBeCloseTo(3); // $3 per 1M tokens
    expect(models[0].priceOut).toBeCloseTo(15);
  });

  it('returns the fallback catalogue when the backend errors', async () => {
    aiModels.mockRejectedValue(new Error('offline'));
    const models = await loadCatalogue({ force: true });
    expect(models.length).toBeGreaterThan(0);
    expect(models[0]).toHaveProperty('id');
  });

  it('reuses the in-memory cache on subsequent calls', async () => {
    aiModels.mockResolvedValue({ data: [{ id: 'a/b', name: 'B' }] });
    await loadCatalogue({ force: true });
    aiModels.mockClear();
    await loadCatalogue();
    expect(aiModels).not.toHaveBeenCalled();
  });
});

describe('persistModelChoice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConfig.mockResolvedValue({ ai_model: 'openai/gpt-4o' });
    saveConfig.mockResolvedValue(undefined);
  });

  it('writes to ai_model for the default slot', async () => {
    await persistModelChoice('default', 'anthropic/claude');
    const saved = saveConfig.mock.calls[0][0];
    expect(saved.ai_model).toBe('anthropic/claude');
  });

  it('writes to the matching per-task field', async () => {
    await persistModelChoice('chat', 'anthropic/claude');
    const saved = saveConfig.mock.calls[0][0];
    expect(saved.ai_model_chat).toBe('anthropic/claude');
  });

  it('clears the field when modelId is null', async () => {
    getConfig.mockResolvedValue({ ai_model_chat: 'old' });
    await persistModelChoice('chat', null);
    const saved = saveConfig.mock.calls[0][0];
    expect(saved.ai_model_chat).toBeNull();
  });

  it('rejects unknown feature keys', async () => {
    await expect(persistModelChoice('bogus', 'x')).rejects.toThrow(/Unknown feature/);
  });
});
