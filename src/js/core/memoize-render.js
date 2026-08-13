// memoize-render.js - shared render memoization for the diagram engines.
//
// Extracted because the same subtle bug was written twice: both the Mermaid and
// the PlantUML adapters cached the RESOLVED SVG string instead of the promise,
// so the second render of an unchanged diagram returned a plain string and the
// caller's `.then(...)` threw "then is not a function". In the preview that
// means the diagram is stuck on its loading placeholder from the second render
// onward, and — because the error escapes the diagram pass — the Mermaid and
// syntax-highlight passes queued behind it never run at all.
//
// One implementation, one place to get it right.

/**
 * Memoize an async producer by key. The PROMISE is cached, never its resolved
 * value, so the return type is the same on a hit as on a miss.
 *
 * Concurrent duplicate calls also share one render, and failures are evicted so
 * a transient error (engine not installed yet, timeout) doesn't poison the
 * cache forever.
 *
 * @param {Map<string, Promise<*>>} cache
 * @param {string} key
 * @param {() => Promise<*>} produce
 * @returns {Promise<*>} always a promise, hit or miss
 */
export function memoizeRender(cache, key, produce) {
  const hit = cache.get(key);
  if (hit) return hit;
  const run = produce();
  cache.set(key, run);
  run.catch(() => {
    if (cache.get(key) === run) cache.delete(key);
  });
  return run;
}
