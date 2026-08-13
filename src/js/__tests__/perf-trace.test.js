import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as perf from '../core/perf-trace.js';

describe('perf-trace', () => {
  beforeEach(() => {
    perf.disable();
    perf.reset();
  });

  afterEach(() => {
    perf.disable();
    perf.reset();
  });

  describe('summarize (pure)', () => {
    it('returns nothing for no samples', () => {
      expect(perf.summarize(new Map())).toEqual([]);
    });

    it('skips labels with an empty or missing sample list', () => {
      const raw = new Map([
        ['empty', []],
        ['missing', undefined],
        ['real', [1]],
      ]);
      expect(perf.summarize(raw).map((r) => r.label)).toEqual(['real']);
    });

    it('computes count, total, mean, percentiles and max', () => {
      const raw = new Map([['parse', [10, 20, 30, 40]]]);
      const [row] = perf.summarize(raw);

      expect(row.label).toBe('parse');
      expect(row.count).toBe(4);
      expect(row.total).toBe(100);
      expect(row.mean).toBe(25);
      expect(row.max).toBe(40);
      // Nearest-rank: p50 of 4 samples is the 2nd, p95 is the 4th.
      expect(row.p50).toBe(20);
      expect(row.p95).toBe(40);
    });

    it('is insensitive to sample order', () => {
      const ascending = perf.summarize(new Map([['a', [1, 2, 3, 4, 5]]]));
      const shuffled = perf.summarize(new Map([['a', [4, 1, 5, 3, 2]]]));
      expect(shuffled).toEqual(ascending);
    });

    // The whole point of the instrument: a per-block pass that is individually
    // cheap can still dominate, so ranking must be by total, not by mean.
    it('ranks by total cost, not by mean', () => {
      const raw = new Map([
        ['rare-but-slow', [100]], // mean 100, total 100
        ['cheap-but-constant', Array(76).fill(2)], // mean 2, total 152
      ]);
      const [first] = perf.summarize(raw);
      expect(first.label).toBe('cheap-but-constant');
      expect(first.total).toBe(152);
      expect(first.mean).toBeLessThan(perf.summarize(raw)[1].mean);
    });

    it('rounds to 3 decimals', () => {
      const [row] = perf.summarize(new Map([['a', [1 / 3]]]));
      expect(row.mean).toBe(0.333);
    });

    it('accepts any iterable of entries, not just a Map', () => {
      const rows = perf.summarize([['a', [5]]]);
      expect(rows).toHaveLength(1);
      expect(rows[0].total).toBe(5);
    });
  });

  describe('recording', () => {
    it('records nothing while disabled', () => {
      perf.record('a', 5);
      expect(perf.rows()).toEqual([]);
    });

    it('records once enabled', () => {
      perf.enable();
      perf.record('a', 5);
      perf.record('a', 7);

      const [row] = perf.rows();
      expect(row.label).toBe('a');
      expect(row.count).toBe(2);
      expect(row.total).toBe(12);
    });

    it('enable() starts from a clean slate', () => {
      perf.enable();
      perf.record('a', 5);
      perf.enable();
      expect(perf.rows()).toEqual([]);
    });

    it('reset() drops samples but stays enabled', () => {
      perf.enable();
      perf.record('a', 5);
      perf.reset();

      expect(perf.rows()).toEqual([]);
      expect(perf.isEnabled()).toBe(true);
    });

    it('disable() stops further recording', () => {
      perf.enable();
      perf.record('a', 5);
      perf.disable();
      perf.record('a', 5);

      expect(perf.isEnabled()).toBe(false);
    });
  });

  describe('time', () => {
    it('returns the callback result while disabled and records nothing', () => {
      const fn = vi.fn(() => 42);
      expect(perf.time('a', fn)).toBe(42);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(perf.rows()).toEqual([]);
    });

    it('returns the callback result and records one sample when enabled', () => {
      perf.enable();
      expect(perf.time('a', () => 42)).toBe(42);

      const [row] = perf.rows();
      expect(row.label).toBe('a');
      expect(row.count).toBe(1);
      expect(row.total).toBeGreaterThanOrEqual(0);
    });

    it('records the time a throwing callback consumed, and rethrows', () => {
      perf.enable();
      expect(() =>
        perf.time('a', () => {
          throw new Error('boom');
        }),
      ).toThrow('boom');

      const [row] = perf.rows();
      expect(row.count).toBe(1);
    });

    it('calls the callback exactly once per invocation', () => {
      perf.enable();
      const fn = vi.fn(() => 1);
      perf.time('a', fn);
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('timeAsync', () => {
    it('awaits and returns the result', async () => {
      perf.enable();
      const result = await perf.timeAsync('a', async () => 'done');

      expect(result).toBe('done');
      expect(perf.rows()[0].count).toBe(1);
    });

    it('records a rejected call and rethrows', async () => {
      perf.enable();
      await expect(
        perf.timeAsync('a', async () => Promise.reject(new Error('nope'))),
      ).rejects.toThrow('nope');
      expect(perf.rows()[0].count).toBe(1);
    });

    it('passes the result through untouched while disabled', async () => {
      const result = await perf.timeAsync('a', async () => 'done');
      expect(result).toBe('done');
      expect(perf.rows()).toEqual([]);
    });
  });

  describe('installGlobal', () => {
    it('exposes the control surface on the target', () => {
      const target = {};
      const api = perf.installGlobal(target);

      expect(target.__fudePerf).toBe(api);
      for (const fn of ['enable', 'disable', 'isEnabled', 'reset', 'record', 'rows', 'report']) {
        expect(typeof api[fn]).toBe('function');
      }
    });

    it('returns null when there is no target', () => {
      expect(perf.installGlobal(null)).toBe(null);
    });

    it('drives the same module state as the direct exports', () => {
      const target = {};
      perf.installGlobal(target);

      target.__fudePerf.enable();
      perf.record('a', 3);

      expect(target.__fudePerf.rows()[0].total).toBe(3);
    });
  });

  describe('report', () => {
    it('logs a hint instead of an empty table when nothing was recorded', () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      const table = vi.spyOn(console, 'table').mockImplementation(() => {});

      expect(perf.report()).toEqual([]);
      expect(info).toHaveBeenCalled();
      expect(table).not.toHaveBeenCalled();

      info.mockRestore();
      table.mockRestore();
    });

    it('prints and returns the rows when there are samples', () => {
      const table = vi.spyOn(console, 'table').mockImplementation(() => {});
      perf.enable();
      perf.record('a', 1);

      const r = perf.report();
      expect(r).toHaveLength(1);
      expect(table).toHaveBeenCalledWith(r);

      table.mockRestore();
    });
  });
});
