// preview-scheduler.js - coalesce preview re-renders during typing.
//
// Re-rendering the preview means a full markdown-it parse plus an innerHTML
// replacement of the whole document, and the caller then reads scrollTop back
// (a forced layout). Doing that once per keystroke is the single most
// expensive thing the editor does while typing, and it grows with document
// size — on a slow compositor (software rendering, WSLg) a long document can
// stutter badly.
//
// A plain debounce is not enough. It only fires after a pause longer than the
// delay, so at a sustained ~8 characters/second (≈125 ms between keys) a
// 120 ms debounce still fires between nearly every keystroke and saves almost
// nothing. So the scheduler pairs a short debounce with a MAX WAIT: during a
// continuous burst the preview still refreshes at a bounded rate, and as soon
// as the typist pauses it catches up quickly.
//
//   delay   — quiet period after the last change before rendering
//   maxWait — hard ceiling on how long a pending change may wait
//
// Renders are coalesced per key (a pane), so two panes never starve each other.

/** Quiet period after the last edit before the preview re-renders. */
export const PREVIEW_DEBOUNCE_MS = 100;

/**
 * Upper bound on how long a pending edit may wait. Sustained typing therefore
 * refreshes the preview at least every 250 ms (~4/s) instead of once per
 * keystroke, while a pause still lands within PREVIEW_DEBOUNCE_MS.
 */
export const PREVIEW_MAX_WAIT_MS = 250;

/**
 * Create a scheduler that coalesces render requests per key.
 *
 * @param {(job: any) => void} render Invoked with the most recent job for a
 *   key when its render is due. Never called with a superseded job.
 * @param {object} [opts]
 * @param {number} [opts.delay] Quiet period, ms.
 * @param {number} [opts.maxWait] Max time a pending job may wait, ms. Values
 *   below `delay` are raised to `delay` so the two can never disagree.
 * @returns {{
 *   schedule: (key: any, job: any) => void,
 *   flush: (key: any) => boolean,
 *   flushAll: () => number,
 *   cancel: (key: any) => boolean,
 *   cancelAll: () => number,
 *   isPending: (key: any) => boolean,
 *   pendingCount: () => number,
 * }}
 */
export function createPreviewScheduler(render, opts = {}) {
  const delay = opts.delay ?? PREVIEW_DEBOUNCE_MS;
  const maxWait = Math.max(delay, opts.maxWait ?? PREVIEW_MAX_WAIT_MS);

  // key -> { job, first, timer }. `first` is when this burst started, i.e. the
  // timestamp the maxWait ceiling is measured from.
  const pending = new Map();

  /**
   * Render the job held for `key`, if any. The entry is dropped BEFORE render
   * runs, so a render that schedules another one (or throws) leaves the map in
   * a consistent state rather than losing or replaying work.
   */
  function run(key) {
    const entry = pending.get(key);
    if (!entry) return false;
    pending.delete(key);
    // No-op when the timer already fired; needed when run() came from flush().
    if (entry.timer !== null) clearTimeout(entry.timer);
    render(entry.job);
    return true;
  }

  function schedule(key, job) {
    const now = Date.now();
    let entry = pending.get(key);
    if (entry) {
      // Supersede the queued job; the burst's start time is preserved so the
      // maxWait ceiling keeps counting from the first unrendered edit.
      entry.job = job;
      if (entry.timer !== null) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
    } else {
      entry = { job, first: now, timer: null };
      pending.set(key, entry);
    }

    const remaining = Math.min(delay, Math.max(0, maxWait - (now - entry.first)));
    if (remaining <= 0) {
      run(key);
      return;
    }
    entry.timer = setTimeout(() => run(key), remaining);
  }

  /** Render `key`'s pending job now. Returns whether there was one. */
  function flush(key) {
    return run(key);
  }

  /** Render every pending job now. Returns how many ran. */
  function flushAll() {
    let n = 0;
    for (const key of [...pending.keys()]) if (run(key)) n++;
    return n;
  }

  /**
   * Drop `key`'s pending job without rendering. Use when the caller is about
   * to render that pane itself, so the queued render does not run twice.
   */
  function cancel(key) {
    const entry = pending.get(key);
    if (!entry) return false;
    if (entry.timer !== null) clearTimeout(entry.timer);
    pending.delete(key);
    return true;
  }

  function cancelAll() {
    let n = 0;
    for (const key of [...pending.keys()]) if (cancel(key)) n++;
    return n;
  }

  const isPending = (key) => pending.has(key);
  const pendingCount = () => pending.size;

  return { schedule, flush, flushAll, cancel, cancelAll, isPending, pendingCount };
}
