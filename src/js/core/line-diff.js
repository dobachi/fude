// line-diff.js - Minimal line-level diff (LCS based), no dependencies.
//
// Used by the save-conflict dialog to show what changed on disk vs. the
// editor. Pure and synchronous so it can be unit tested directly.

// Files larger than this many lines skip the (O(n*m)) LCS to avoid a huge
// table; the caller still gets a coarse "everything changed" representation.
const MAX_LINES = 4000;

/**
 * Split text into lines, preserving content but not the trailing newline.
 * @param {string} text
 * @returns {string[]}
 */
function toLines(text) {
  if (text === '' || text == null) return [];
  return String(text).split('\n');
}

/**
 * Compute a line-level diff between two texts.
 * @param {string} oldText  the previous version (e.g. disk)
 * @param {string} newText  the new version (e.g. editor)
 * @returns {Array<{type: 'equal'|'add'|'del', value: string}>}
 *   ordered hunks; 'del' = only in oldText, 'add' = only in newText.
 */
export function diffLines(oldText, newText) {
  const a = toLines(oldText);
  const b = toLines(newText);

  // Fast path: identical.
  if (a.length === b.length && a.every((line, i) => line === b[i])) {
    return a.map((value) => ({ type: 'equal', value }));
  }

  // Guard against pathological sizes: fall back to a wholesale replace.
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [
      ...a.map((value) => ({ type: 'del', value })),
      ...b.map((value) => ({ type: 'add', value })),
    ];
  }

  // LCS table (lengths). lcs[i][j] = LCS length of a[i:] and b[j:].
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  // Backtrack to produce the diff.
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'equal', value: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ type: 'del', value: a[i] });
      i++;
    } else {
      out.push({ type: 'add', value: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ type: 'del', value: a[i++] });
  while (j < m) out.push({ type: 'add', value: b[j++] });
  return out;
}

/**
 * Count added/removed lines in a diff.
 * @param {Array<{type: string}>} diff
 * @returns {{added: number, removed: number}}
 */
export function diffStats(diff) {
  let added = 0;
  let removed = 0;
  for (const d of diff) {
    if (d.type === 'add') added++;
    else if (d.type === 'del') removed++;
  }
  return { added, removed };
}
