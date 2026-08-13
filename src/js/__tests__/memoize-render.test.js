import { describe, it, expect, vi } from 'vitest';
import { memoizeRender } from '../core/memoize-render.js';

describe('memoizeRender', () => {
  // Regression, written twice over: both the Mermaid and the PlantUML adapters
  // cached the resolved SVG string, so a second render of the same diagram
  // returned a string and the caller's `.then(...)` threw
  // "then is not a function". That is why this helper is shared now.
  it('returns a promise on a cache hit, not the resolved value', async () => {
    const cache = new Map();
    const produce = () => Promise.resolve('<svg/>');
    await memoizeRender(cache, 'k', produce);

    const second = memoizeRender(cache, 'k', produce);
    expect(typeof second.then).toBe('function');
    await expect(second).resolves.toBe('<svg/>');
  });

  it('runs the producer once for repeated keys', async () => {
    const cache = new Map();
    const produce = vi.fn(() => Promise.resolve('<svg/>'));
    await memoizeRender(cache, 'k', produce);
    await memoizeRender(cache, 'k', produce);
    expect(produce).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight render between concurrent calls', async () => {
    const cache = new Map();
    const produce = vi.fn(() => Promise.resolve('<svg/>'));
    const a = memoizeRender(cache, 'k', produce);
    const b = memoizeRender(cache, 'k', produce);
    expect(a).toBe(b);
    expect(produce).toHaveBeenCalledTimes(1);
    await a;
  });

  it('keys renders separately', async () => {
    const cache = new Map();
    const produce = vi.fn((v) => Promise.resolve(v));
    await memoizeRender(cache, 'a', () => produce('A'));
    await memoizeRender(cache, 'b', () => produce('B'));
    expect(produce).toHaveBeenCalledTimes(2);
    await expect(cache.get('a')).resolves.toBe('A');
    await expect(cache.get('b')).resolves.toBe('B');
  });

  it('does not cache failures, so a later attempt can retry', async () => {
    const cache = new Map();
    const produce = vi
      .fn()
      .mockRejectedValueOnce(new Error('engine missing'))
      .mockResolvedValueOnce('<svg/>');

    await expect(memoizeRender(cache, 'k', produce)).rejects.toThrow('engine missing');
    expect(cache.has('k')).toBe(false);
    await expect(memoizeRender(cache, 'k', produce)).resolves.toBe('<svg/>');
  });
});
