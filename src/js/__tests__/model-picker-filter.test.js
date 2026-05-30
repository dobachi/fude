import { describe, it, expect } from 'vitest';
import { filterAndSort } from '../features/ai/model-picker-modal.js';

const SAMPLE = [
  {
    id: 'anthropic/claude-sonnet-4.5',
    name: 'Claude Sonnet 4.5',
    provider: 'anthropic',
    contextLength: 200000,
    priceIn: 3,
    priceOut: 15,
  },
  {
    id: 'anthropic/claude-haiku-4.5',
    name: 'Claude Haiku 4.5',
    provider: 'anthropic',
    contextLength: 200000,
    priceIn: 0.8,
    priceOut: 4,
  },
  {
    id: 'openai/gpt-4o',
    name: 'GPT-4o',
    provider: 'openai',
    contextLength: 128000,
    priceIn: 5,
    priceOut: 15,
  },
  {
    id: 'openai/gpt-4o-mini',
    name: 'GPT-4o Mini',
    provider: 'openai',
    contextLength: 128000,
    priceIn: 0.15,
    priceOut: 0.6,
  },
  {
    id: 'google/gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    provider: 'google',
    contextLength: 1_000_000,
    priceIn: 0.075,
    priceOut: 0.3,
  },
];

describe('filterAndSort', () => {
  it('returns the full list sorted by name when query is empty', () => {
    const r = filterAndSort(SAMPLE, '', 'name');
    expect(r.map((m) => m.id)).toEqual([
      'anthropic/claude-haiku-4.5',
      'anthropic/claude-sonnet-4.5',
      'google/gemini-2.5-flash',
      'openai/gpt-4o',
      'openai/gpt-4o-mini',
    ]);
  });

  it('matches id, name, and provider case-insensitively', () => {
    expect(filterAndSort(SAMPLE, 'claude', 'name').map((m) => m.id)).toEqual([
      'anthropic/claude-haiku-4.5',
      'anthropic/claude-sonnet-4.5',
    ]);
    expect(filterAndSort(SAMPLE, 'ANTHROPIC', 'name').map((m) => m.provider)).toEqual([
      'anthropic',
      'anthropic',
    ]);
    expect(filterAndSort(SAMPLE, 'gpt-4o', 'name').map((m) => m.id)).toEqual([
      'openai/gpt-4o',
      'openai/gpt-4o-mini',
    ]);
  });

  it('sorts by context length descending', () => {
    const r = filterAndSort(SAMPLE, '', 'context');
    expect(r.map((m) => m.id)[0]).toBe('google/gemini-2.5-flash'); // 1M
    expect(r.map((m) => m.id).slice(-1)[0]).toMatch(/gpt-4o/); // 128k
  });

  it('sorts by price (cheapest first by average of in/out)', () => {
    const r = filterAndSort(SAMPLE, '', 'price');
    // Gemini 2.5 Flash is the cheapest, GPT-4o is the most expensive
    expect(r[0].id).toBe('google/gemini-2.5-flash');
    expect(r[r.length - 1].id).toBe('openai/gpt-4o');
  });

  it('sorts by provider then name', () => {
    const r = filterAndSort(SAMPLE, '', 'provider');
    expect(r.map((m) => m.provider)).toEqual([
      'anthropic',
      'anthropic',
      'google',
      'openai',
      'openai',
    ]);
  });

  it('returns empty array when no match', () => {
    expect(filterAndSort(SAMPLE, 'zzzz', 'name')).toEqual([]);
  });

  it('handles null/undefined catalogue gracefully', () => {
    expect(filterAndSort(null, '', 'name')).toEqual([]);
    expect(filterAndSort(undefined, 'claude', 'price')).toEqual([]);
  });
});
