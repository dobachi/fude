// task-list.js - GitHub-style task lists: `- [ ] todo` / `- [x] done`.
//
// Two halves:
//   * taskListPlugin(md) renders the marker as a checkbox in the preview.
//   * taskToggleChange(...) turns a click on that checkbox into an edit of the
//     Markdown source. The source stays the single source of truth; the preview
//     only asks for a change and then re-renders from the edited text.

const CHECKBOX_CLASS = 'task-list-item-checkbox';

// A task marker at the start of a list item's inline text: "[ ]", "[x]", "[X]",
// followed by whitespace or the end of the item (GitHub requires the gap).
const INLINE_MARKER = /^\[([ xX])\](?=\s|$)/;

// The same marker as it appears on a source line: optional blockquote prefixes,
// indentation, a bullet or ordinal, whitespace, then "[" state "]".
// Group 1 is everything up to and including "[", group 2 the state character.
const SOURCE_MARKER = /^((?:[ \t]*>)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[)([ xX])\](?=\s|$)/;

/**
 * markdown-it plugin: render `[ ]` / `[x]` at the start of a list item as a
 * checkbox. The checkbox carries no line number of its own; its enclosing
 * `<li>` (or loose-list `<p>`) already has `data-source-line`, which is the
 * line the marker sits on.
 * @param {object} md markdown-it instance
 */
export function taskListPlugin(md) {
  md.core.ruler.push('task_list', (state) => {
    const tokens = state.tokens;
    for (let i = 2; i < tokens.length; i++) {
      const inline = tokens[i];
      if (inline.type !== 'inline') continue;
      const para = tokens[i - 1];
      const item = tokens[i - 2];
      if (para.type !== 'paragraph_open' || item.type !== 'list_item_open') continue;
      // The marker must be on the item's first line ("-\n  [ ] x" is not a task),
      // otherwise the line we'd edit on click is not the one holding it.
      if (!para.map || !item.map || para.map[0] !== item.map[0]) continue;

      const first = inline.children && inline.children[0];
      if (!first || first.type !== 'text') continue;
      const m = INLINE_MARKER.exec(first.content);
      if (!m) continue;

      const checked = m[1] !== ' ';
      first.content = first.content.slice(m[0].length).replace(/^[ \t]/, '');
      const box = new state.Token('html_inline', '', 0);
      box.content = `<input type="checkbox" class="${CHECKBOX_CLASS}"${checked ? ' checked' : ''}>`;
      inline.children.unshift(box);

      item.attrJoin('class', 'task-list-item');
      markParentList(tokens, i - 2);
    }
  });
}

function markParentList(tokens, itemIndex) {
  const level = tokens[itemIndex].level - 1;
  for (let j = itemIndex - 1; j >= 0; j--) {
    const t = tokens[j];
    if (t.level !== level) continue;
    if (t.type === 'bullet_list_open' || t.type === 'ordered_list_open') {
      const cls = t.attrGet('class') || '';
      if (!cls.split(' ').includes('contains-task-list')) t.attrJoin('class', 'contains-task-list');
    }
    return;
  }
}

/** True if `el` is a task checkbox rendered by taskListPlugin. */
export function isTaskCheckbox(el) {
  return !!(el && el.classList && el.classList.contains(CHECKBOX_CLASS));
}

/**
 * Compute the source edit that toggles the task marker on one line.
 *
 * `wasChecked` is the state the preview showed when clicked. The preview
 * re-renders on a debounce, so it can lag the source; if the source no longer
 * agrees, toggling would flip the box the other way from what the user saw, so
 * we refuse and let the pending re-render catch the preview up.
 *
 * @param {string} lineText text of the source line holding the marker
 * @param {number} lineFrom document offset of the start of that line
 * @param {boolean} wasChecked checkbox state as rendered
 * @returns {{from: number, to: number, insert: string} | null}
 */
export function taskToggleChange(lineText, lineFrom, wasChecked) {
  const m = SOURCE_MARKER.exec(lineText);
  if (!m) return null;
  const checked = m[2] !== ' ';
  if (checked !== wasChecked) return null;
  const from = lineFrom + m[1].length;
  return { from, to: from + 1, insert: checked ? ' ' : 'x' };
}
