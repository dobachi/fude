// perf-trace.js - opt-in timing for hot paths, driven from devtools.
//
// The preview pipeline has several candidate bottlenecks and guessing which
// one dominates is unreliable: it depends on the document (diagram-heavy vs
// plain prose) and on the compositor (a GPU-accelerated desktop vs software
// rendering under WSLg). So instead of optimizing on a hunch, this records
// where the time actually goes on the machine that feels slow.
//
// Usage (devtools console; Tauri ships devtools in this app):
//
//   __fudePerf.enable()     // start recording
//   ...type in the editor for a while...
//   __fudePerf.report()     // console.table, biggest total cost first
//   __fudePerf.disable()    // stop
//
// Disabled by default and cheap when off: every entry point checks the flag
// before touching the clock, so a production run pays one boolean test.

let enabled = false;

/** label -> durations in ms */
const samples = new Map();

const now = () =>
  typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();

export function enable() {
  enabled = true;
  samples.clear();
}

export function disable() {
  enabled = false;
}

export function isEnabled() {
  return enabled;
}

export function reset() {
  samples.clear();
}

/** Record one duration. No-op while disabled. */
export function record(label, ms) {
  if (!enabled) return;
  let arr = samples.get(label);
  if (!arr) {
    arr = [];
    samples.set(label, arr);
  }
  arr.push(ms);
}

/**
 * Time a synchronous call. Returns whatever `fn` returns, and records even
 * when it throws — a pass that fails partway still consumed time, and hiding
 * that would bias the report toward the healthy paths.
 */
export function time(label, fn) {
  if (!enabled) return fn();
  const t0 = now();
  try {
    return fn();
  } finally {
    record(label, now() - t0);
  }
}

/**
 * Time an async call from the outside. Same contract as `time`.
 *
 * CAUTION: `await` always yields to the microtask queue, so this stops the
 * clock only after the caller's remaining SYNCHRONOUS work has run. Wrapping a
 * pass that returns early therefore reports the caller's tail as if it were
 * the pass's own cost — which is how a PlantUML pass with no diagrams to draw
 * came out at 95 ms, exactly matching the caller's forced layout.
 *
 * Use `start()` from inside the measured function instead whenever the
 * function can complete without a real await.
 */
export async function timeAsync(label, fn) {
  if (!enabled) return fn();
  const t0 = now();
  try {
    return await fn();
  } finally {
    record(label, now() - t0);
  }
}

/**
 * Start a timer, to be stopped from inside the measured function.
 *
 * Because the stop lands in that function's own `finally`, a body that
 * finishes synchronously is charged nothing for whatever the caller does
 * afterwards. Returns a no-op while disabled.
 *
 *   async function pass() {
 *     const done = start('label');
 *     try { ... } finally { done(); }
 *   }
 */
export function start(label) {
  if (!enabled) return () => {};
  const t0 = now();
  return () => record(label, now() - t0);
}

/** Round to 3 decimals so the table stays readable at sub-ms resolution. */
function round(n) {
  return Math.round(n * 1000) / 1000;
}

/** Nearest-rank percentile over an already-sorted array. */
function percentile(sorted, q) {
  if (!sorted.length) return 0;
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/**
 * Summarize raw samples into report rows, most expensive total first. Pure —
 * `raw` is any Map (or iterable of [label, number[]] entries), so this is
 * testable without touching the clock or module state.
 *
 * Sorting by TOTAL rather than mean is deliberate: a pass that is individually
 * cheap but runs on every block can still dominate, and that is exactly the
 * case this instrument exists to detect.
 */
export function summarize(raw) {
  const rows = [];
  for (const [label, values] of raw) {
    if (!values || !values.length) continue;
    const sorted = [...values].sort((a, b) => a - b);
    const total = sorted.reduce((a, b) => a + b, 0);
    rows.push({
      label,
      count: sorted.length,
      total: round(total),
      mean: round(total / sorted.length),
      p50: round(percentile(sorted, 0.5)),
      p95: round(percentile(sorted, 0.95)),
      max: round(sorted[sorted.length - 1]),
    });
  }
  rows.sort((a, b) => b.total - a.total);
  return rows;
}

/** Report rows for the samples collected so far. */
export function rows() {
  return summarize(samples);
}

/** Print the report. Returns the rows so it is also usable programmatically. */
export function report() {
  const r = rows();
  if (!r.length) {
    console.info('[perf] no samples — call __fudePerf.enable() first, then reproduce the slowness');
    return r;
  }
  // console.table is the point of this function: a column per statistic is far
  // easier to read than a formatted string, and this only runs when a developer
  // asks for the report from devtools.
  // eslint-disable-next-line no-console
  console.table(r);
  return r;
}

/**
 * Expose the tracer on `window` so it can be driven from devtools without a
 * rebuild. Safe to call more than once.
 */
export function installGlobal(target = typeof window !== 'undefined' ? window : null) {
  if (!target) return null;
  const api = { enable, disable, isEnabled, reset, record, rows, report };
  target.__fudePerf = api;
  return api;
}
