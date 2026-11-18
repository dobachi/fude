// section-numbers.js - automatic section numbers ("1", "1.2", "1.2.3") on the
// preview's headings, so a deep document stays easy to navigate.
//
// The number is not written into the heading text. It goes into a
// `data-section-number` attribute and CSS draws it with ::before, so the
// heading's text, its id (anchor links) and the source stay untouched, and
// copying a heading does not pick up the number.

const NUMBER_ATTR = 'data-section-number';

/**
 * The heading level that numbering starts from.
 *
 * Normally the shallowest level in the document. One exception: a document
 * that opens with its only `#` heading is using it as the title (`# Title`
 * followed by `## ...` sections). The title is left unnumbered and the
 * sections become 1, 2, 3 — rather than everything being "1.x". Only h1 counts
 * as a title: a lone leading `##` is just the first section.
 *
 * @param {number[]} levels heading levels (1-6) in document order
 * @returns {number|null} null when there is nothing to number
 */
export function numberingBaseLevel(levels) {
  if (!levels.length) return null;
  const min = Math.min(...levels);
  const atMin = levels.filter((l) => l === min).length;
  if (min === 1 && atMin === 1 && levels[0] === 1 && levels.length > 1) {
    return Math.min(...levels.slice(1));
  }
  return min;
}

/**
 * Section numbers for a sequence of headings.
 *
 * Headings above the base level (see numberingBaseLevel) get null. A heading
 * that skips levels (## then ####) gets a 0 for the missing level ("1.0.1"),
 * as Pandoc does, so the depth of every number still matches its level.
 *
 * @param {number[]} levels heading levels (1-6) in document order
 * @returns {(string|null)[]} one entry per heading
 */
export function computeSectionNumbers(levels) {
  const base = numberingBaseLevel(levels);
  if (base === null) return [];
  const counters = [];
  return levels.map((level) => {
    if (level < base) {
      // A heading above the numbered range (the title) restarts the count.
      counters.length = 0;
      return null;
    }
    const depth = level - base; // 0-based
    while (counters.length < depth) counters.push(0);
    counters.length = depth + 1;
    counters[depth] = (counters[depth] || 0) + 1;
    return counters.join('.');
  });
}

/**
 * Number (or un-number) the headings of a rendered preview.
 *
 * Only the container's direct children are taken: those are the document's
 * own headings. Headings nested in a blockquote, a list or the Quarto
 * front-matter title block are not sections.
 *
 * @param {HTMLElement} container
 * @param {boolean} enabled
 */
export function applySectionNumbers(container, enabled) {
  if (!container) return;
  const headings = Array.from(container.children).filter((el) => /^H[1-6]$/.test(el.tagName));
  if (!enabled) {
    for (const h of headings) h.removeAttribute(NUMBER_ATTR);
    return;
  }
  const numbers = computeSectionNumbers(headings.map((h) => Number(h.tagName[1])));
  headings.forEach((h, i) => {
    const n = numbers[i];
    if (n) h.setAttribute(NUMBER_ATTR, n);
    else h.removeAttribute(NUMBER_ATTR);
  });
}
