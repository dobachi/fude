import { describe, it, expect } from 'vitest';
import { describeManualCheck } from '../core/updater.js';

describe('describeManualCheck', () => {
  it('reports unsupported (browser) mode as an error', () => {
    const r = describeManualCheck({ isDesktop: false, update: null, error: null });
    expect(r.kind).toBe('unsupported');
    expect(r.type).toBe('error');
    expect(r.message).toContain('デスクトップ版');
  });

  it('reports an available update with its version', () => {
    const r = describeManualCheck({ isDesktop: true, update: { version: '0.4.29' }, error: null });
    expect(r.kind).toBe('update');
    expect(r.version).toBe('0.4.29');
  });

  it('reports up-to-date when no update and no error', () => {
    const r = describeManualCheck({ isDesktop: true, update: null, error: null });
    expect(r.kind).toBe('latest');
    expect(r.type).toBe('info');
    expect(r.message).toContain('最新');
  });

  it('reports the error message when the check failed', () => {
    const r = describeManualCheck({ isDesktop: true, update: null, error: 'network down' });
    expect(r.kind).toBe('error');
    expect(r.type).toBe('error');
    expect(r.message).toContain('network down');
  });

  it('prioritizes the unsupported case even if an error is present', () => {
    const r = describeManualCheck({ isDesktop: false, update: null, error: 'boom' });
    expect(r.kind).toBe('unsupported');
  });
});
