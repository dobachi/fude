import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createPreviewScheduler,
  PREVIEW_DEBOUNCE_MS,
  PREVIEW_MAX_WAIT_MS,
} from '../core/preview-scheduler.js';

describe('preview-scheduler', () => {
  let render;

  beforeEach(() => {
    vi.useFakeTimers();
    render = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('debounce', () => {
    it('does not render synchronously on schedule', () => {
      const s = createPreviewScheduler(render, { delay: 100, maxWait: 250 });
      s.schedule('pane', 'a');
      expect(render).not.toHaveBeenCalled();
      expect(s.isPending('pane')).toBe(true);
    });

    it('renders once the quiet period elapses', () => {
      const s = createPreviewScheduler(render, { delay: 100, maxWait: 250 });
      s.schedule('pane', 'a');

      vi.advanceTimersByTime(99);
      expect(render).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(render).toHaveBeenCalledTimes(1);
      expect(render).toHaveBeenCalledWith('a');
      expect(s.isPending('pane')).toBe(false);
    });

    it('renders only the newest job when edits are superseded', () => {
      const s = createPreviewScheduler(render, { delay: 100, maxWait: 250 });
      s.schedule('pane', 'v1');
      vi.advanceTimersByTime(50);
      s.schedule('pane', 'v2');
      vi.advanceTimersByTime(50);
      s.schedule('pane', 'v3');
      vi.advanceTimersByTime(100);

      expect(render).toHaveBeenCalledTimes(1);
      expect(render).toHaveBeenCalledWith('v3');
    });
  });

  describe('max wait', () => {
    // The reason this scheduler is not a plain debounce: at a sustained typing
    // rate faster than the debounce delay, a debounce would fire after nearly
    // every keystroke and save nothing.
    it('renders during a burst that never pauses long enough to debounce', () => {
      const s = createPreviewScheduler(render, { delay: 100, maxWait: 250 });

      // A keystroke every 60 ms — always shorter than the 100 ms quiet period,
      // so a plain debounce would never fire while typing continues.
      for (let i = 0; i < 10; i++) {
        s.schedule('pane', `v${i}`);
        vi.advanceTimersByTime(60);
      }

      expect(render).toHaveBeenCalled();
    });

    it('bounds how long an edit can wait', () => {
      const s = createPreviewScheduler(render, { delay: 100, maxWait: 250 });

      s.schedule('pane', 'v0'); // t=0, burst starts
      vi.advanceTimersByTime(60); // t=60
      s.schedule('pane', 'v1');
      vi.advanceTimersByTime(60); // t=120
      s.schedule('pane', 'v2');
      vi.advanceTimersByTime(60); // t=180
      s.schedule('pane', 'v3');
      expect(render).not.toHaveBeenCalled();

      // The burst started at t=0, so the ceiling lands at t=250.
      vi.advanceTimersByTime(69); // t=249
      expect(render).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1); // t=250
      expect(render).toHaveBeenCalledTimes(1);
      expect(render).toHaveBeenCalledWith('v3');
    });

    it('starts a fresh ceiling for the next burst', () => {
      const s = createPreviewScheduler(render, { delay: 100, maxWait: 250 });

      s.schedule('pane', 'a');
      vi.advanceTimersByTime(100);
      expect(render).toHaveBeenCalledTimes(1);

      // Second burst: the ceiling is measured from here, not from t=0.
      s.schedule('pane', 'b');
      vi.advanceTimersByTime(60);
      s.schedule('pane', 'c');
      vi.advanceTimersByTime(100);
      expect(render).toHaveBeenCalledTimes(2);
      expect(render).toHaveBeenLastCalledWith('c');
    });

    it('renders immediately when the ceiling has already passed', () => {
      const s = createPreviewScheduler(render, { delay: 100, maxWait: 250 });

      s.schedule('pane', 'a'); // t=0
      // Jump past the ceiling without letting the timer fire, then schedule
      // again: the new job is already overdue and must not wait another delay.
      s.cancel('pane');
      s.schedule('pane', 'b');
      vi.advanceTimersByTime(250);
      render.mockClear();

      // Now a burst whose ceiling is exceeded mid-schedule.
      s.schedule('pane', 'c'); // burst starts
      vi.advanceTimersByTime(250);
      expect(render).toHaveBeenCalledTimes(1);
    });

    it('raises a maxWait below delay up to delay', () => {
      const s = createPreviewScheduler(render, { delay: 100, maxWait: 10 });
      s.schedule('pane', 'a');
      vi.advanceTimersByTime(99);
      expect(render).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(render).toHaveBeenCalledTimes(1);
    });
  });

  describe('per-key isolation', () => {
    it('keeps separate pending jobs for separate keys', () => {
      const s = createPreviewScheduler(render, { delay: 100, maxWait: 250 });
      const paneA = { id: 'a' };
      const paneB = { id: 'b' };

      s.schedule(paneA, 'jobA');
      s.schedule(paneB, 'jobB');
      expect(s.pendingCount()).toBe(2);

      vi.advanceTimersByTime(100);
      expect(render).toHaveBeenCalledTimes(2);
      expect(render).toHaveBeenCalledWith('jobA');
      expect(render).toHaveBeenCalledWith('jobB');
    });

    it('cancelling one key leaves the other pending', () => {
      const s = createPreviewScheduler(render, { delay: 100, maxWait: 250 });
      s.schedule('a', 'jobA');
      s.schedule('b', 'jobB');

      expect(s.cancel('a')).toBe(true);
      vi.advanceTimersByTime(100);

      expect(render).toHaveBeenCalledTimes(1);
      expect(render).toHaveBeenCalledWith('jobB');
    });
  });

  describe('flush', () => {
    it('renders the pending job immediately', () => {
      const s = createPreviewScheduler(render, { delay: 100, maxWait: 250 });
      s.schedule('pane', 'a');

      expect(s.flush('pane')).toBe(true);
      expect(render).toHaveBeenCalledTimes(1);
      expect(render).toHaveBeenCalledWith('a');
      expect(s.isPending('pane')).toBe(false);
    });

    it('does not render again when the timer would have fired', () => {
      const s = createPreviewScheduler(render, { delay: 100, maxWait: 250 });
      s.schedule('pane', 'a');
      s.flush('pane');

      vi.advanceTimersByTime(1000);
      expect(render).toHaveBeenCalledTimes(1);
    });

    it('is a no-op with nothing pending', () => {
      const s = createPreviewScheduler(render, { delay: 100, maxWait: 250 });
      expect(s.flush('pane')).toBe(false);
      expect(render).not.toHaveBeenCalled();
    });

    it('flushAll renders every pending job and reports the count', () => {
      const s = createPreviewScheduler(render, { delay: 100, maxWait: 250 });
      s.schedule('a', 'jobA');
      s.schedule('b', 'jobB');

      expect(s.flushAll()).toBe(2);
      expect(render).toHaveBeenCalledTimes(2);
      expect(s.pendingCount()).toBe(0);
    });
  });

  describe('cancel', () => {
    it('drops the pending job without rendering', () => {
      const s = createPreviewScheduler(render, { delay: 100, maxWait: 250 });
      s.schedule('pane', 'a');

      expect(s.cancel('pane')).toBe(true);
      vi.advanceTimersByTime(1000);

      expect(render).not.toHaveBeenCalled();
      expect(s.isPending('pane')).toBe(false);
    });

    it('reports false with nothing pending', () => {
      const s = createPreviewScheduler(render, { delay: 100, maxWait: 250 });
      expect(s.cancel('pane')).toBe(false);
    });

    it('cancelAll drops everything and reports the count', () => {
      const s = createPreviewScheduler(render, { delay: 100, maxWait: 250 });
      s.schedule('a', 'jobA');
      s.schedule('b', 'jobB');

      expect(s.cancelAll()).toBe(2);
      vi.advanceTimersByTime(1000);

      expect(render).not.toHaveBeenCalled();
      expect(s.pendingCount()).toBe(0);
    });
  });

  // app.js renders a pane directly on disk reload, view-mode change and config
  // change. Each of those cancels the pane's queued job first. This encodes
  // why: without the cancel, the queued job repaints with pre-reload text and
  // the preview ends up disagreeing with the editor.
  describe('contract relied on by direct renders in app.js', () => {
    it('a cancelled job cannot repaint over a newer direct render', () => {
      const paint = [];
      const s = createPreviewScheduler((job) => paint.push(job), {
        delay: 100,
        maxWait: 250,
      });
      const pane = { id: 'p1' };

      s.schedule(pane, 'typed text'); // user types...
      s.cancel(pane); // ...then the file reloads from disk
      paint.push('disk text'); // app.js renders the fresh content itself
      vi.advanceTimersByTime(1000);

      expect(paint).toEqual(['disk text']);
    });

    it('without the cancel the stale job would win — guarding the test above', () => {
      const paint = [];
      const s = createPreviewScheduler((job) => paint.push(job), {
        delay: 100,
        maxWait: 250,
      });
      const pane = { id: 'p1' };

      s.schedule(pane, 'typed text');
      paint.push('disk text');
      vi.advanceTimersByTime(1000);

      // Stale text lands last, i.e. wins. This is the bug the cancel prevents.
      expect(paint).toEqual(['disk text', 'typed text']);
    });
  });

  describe('re-entrancy and failure', () => {
    it('keeps a render scheduled from inside a render', () => {
      const s = createPreviewScheduler((job) => {
        render(job);
        if (job === 'first') s.schedule('pane', 'second');
      });

      s.schedule('pane', 'first');
      vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
      expect(render).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
      expect(render).toHaveBeenCalledTimes(2);
      expect(render).toHaveBeenLastCalledWith('second');
    });

    it('does not replay a job whose render threw', () => {
      const boom = vi.fn(() => {
        throw new Error('render failed');
      });
      const s = createPreviewScheduler(boom, { delay: 100, maxWait: 250 });
      s.schedule('pane', 'a');

      expect(() => vi.advanceTimersByTime(100)).toThrow('render failed');
      expect(s.isPending('pane')).toBe(false);

      vi.advanceTimersByTime(1000);
      expect(boom).toHaveBeenCalledTimes(1);
    });
  });

  it('defaults keep the quiet period below the ceiling', () => {
    expect(PREVIEW_DEBOUNCE_MS).toBeLessThan(PREVIEW_MAX_WAIT_MS);
  });
});
