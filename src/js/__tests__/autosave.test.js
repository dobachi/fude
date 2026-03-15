import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../backend.js', () => ({
  writeTempFile: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  deleteTempFile: vi.fn().mockResolvedValue(undefined),
  checkTempFiles: vi.fn().mockResolvedValue([]),
}));

describe('autosave module', () => {
  let mod;
  let backend;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();

    backend = (await import('../backend.js'));
    mod = await import('../core/autosave.js');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('exports expected functions', () => {
    expect(typeof mod.onContentChange).toBe('function');
    expect(typeof mod.triggerSave).toBe('function');
    expect(typeof mod.checkRecovery).toBe('function');
  });

  it('onContentChange does nothing when path is falsy', () => {
    mod.onContentChange(null, 'content');
    vi.advanceTimersByTime(3000);
    expect(backend.writeTempFile).not.toHaveBeenCalled();
  });

  it('onContentChange debounces and calls writeTempFile', async () => {
    mod.onContentChange('/test.md', 'draft content');

    // Should not be called immediately
    expect(backend.writeTempFile).not.toHaveBeenCalled();

    // Advance past debounce period
    vi.advanceTimersByTime(2500);
    await vi.runAllTimersAsync();

    expect(backend.writeTempFile).toHaveBeenCalledWith('/test.md', 'draft content');
  });

  it('onContentChange resets debounce on rapid calls', async () => {
    mod.onContentChange('/test.md', 'v1');
    vi.advanceTimersByTime(1000);
    mod.onContentChange('/test.md', 'v2');
    vi.advanceTimersByTime(1000);
    mod.onContentChange('/test.md', 'v3');

    // Clear any prior calls before the final debounce fires
    backend.writeTempFile.mockClear();

    vi.advanceTimersByTime(2500);
    await vi.runAllTimersAsync();

    // Only the last call should have gone through
    expect(backend.writeTempFile).toHaveBeenCalledTimes(1);
    expect(backend.writeTempFile).toHaveBeenCalledWith('/test.md', 'v3');
  });

  it('triggerSave writes the file and deletes temp file', async () => {
    const result = await mod.triggerSave('/test.md', '# Final');

    expect(result).toBe(true);
    expect(backend.writeFile).toHaveBeenCalledWith('/test.md', '# Final');
    expect(backend.deleteTempFile).toHaveBeenCalledWith('/test.md');
  });

  it('triggerSave returns false when path is falsy', async () => {
    const result = await mod.triggerSave(null, 'content');
    expect(result).toBe(false);
  });

  it('triggerSave returns false on write failure', async () => {
    backend.writeFile.mockRejectedValueOnce(new Error('write error'));

    const result = await mod.triggerSave('/test.md', 'content');
    expect(result).toBe(false);
  });

  it('checkRecovery returns temp file info', async () => {
    const mockResult = [{ original_path: '/a.md', temp_path: '/tmp/a', modified: '123' }];
    backend.checkTempFiles.mockResolvedValueOnce(mockResult);

    const result = await mod.checkRecovery(['/a.md']);
    expect(result).toEqual(mockResult);
  });

  it('checkRecovery returns empty array on error', async () => {
    backend.checkTempFiles.mockRejectedValueOnce(new Error('fail'));

    const result = await mod.checkRecovery(['/a.md']);
    expect(result).toEqual([]);
  });
});
