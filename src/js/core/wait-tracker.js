// wait-tracker.js - Which open tabs a `fude --wait` caller is blocked on.
//
// The host asks us to open a path with `wait: true`; when the tab for that
// path goes away we tell the host whether its content was kept (closed clean
// or saved) or discarded (closed while dirty), and the host releases the
// waiting process with a matching exit code. Pure bookkeeping: the host
// call is injected so this can be tested without Tauri.

import { samePath } from './pathnorm.js';

/**
 * @param {(path: string, saved: boolean) => void} notify
 */
export function createWaitTracker(notify) {
  // `asked` is the path the host keyed its waiter on; `current` follows the
  // tab through "save as" renames so the eventual close is still matched.
  /** @type {{ asked: string, current: string }[]} */
  let entries = [];

  const byCurrent = (path) => entries.find((e) => samePath(e.current, path));

  return {
    /** Start tracking `path`. Idempotent. */
    add(path) {
      if (!path || entries.some((e) => samePath(e.asked, path))) return;
      entries.push({ asked: path, current: path });
    },

    /** Whether somebody is waiting on the tab currently at `path`. */
    has(path) {
      return !!path && !!byCurrent(path);
    },

    /** Paths currently waited on, as the caller asked for them (copy). */
    list() {
      return entries.map((e) => e.asked);
    },

    /**
     * Feed every tab path change here. A close (`newPath` null) releases the
     * waiter; a rename keeps waiting under the new name.
     * @param {{ oldPath: string|null, newPath: string|null, dirty?: boolean }} change
     */
    onPathChange({ oldPath, newPath, dirty = false }) {
      if (!oldPath) return;
      const entry = byCurrent(oldPath);
      if (!entry) return;
      if (newPath == null) {
        entries = entries.filter((e) => e !== entry);
        notify(entry.asked, !dirty);
      } else {
        entry.current = newPath;
      }
    },
  };
}
