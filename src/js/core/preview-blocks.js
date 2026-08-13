// preview-blocks.js - split a rendered document into top-level blocks and
// update only the ones that changed.
//
// Replacing the whole preview with `container.innerHTML = md.render(text)` is
// the dominant cost of typing. Measured on WSLg (webkit2gtk, software
// rendering), per re-render:
//
//   document              innerHTML   scroll read-back   parse
//   prose only  (218 KB)     170 ms          53 ms       27 ms
//   mixed       (258 KB)     424 ms         166 ms       47 ms
//   code-heavy  (144 KB)     210 ms          95 ms       13 ms
//
// Parsing is 6-11% of that; the rest is tearing the DOM down and building it
// again. Worse, the rebuild also destroys the `dataset` guards that let the
// syntax-highlight and diagram passes skip finished blocks, so every render
// re-highlights every code block and re-processes every diagram — including
// flashing each one back to its "⏳" placeholder.
//
// Typing changes one block. So: parse and render the whole document to HTML
// (cheap), but touch the DOM only where the HTML actually differs. Untouched
// blocks keep their nodes, their highlighting, their rendered SVG and their
// pan/zoom state.

/**
 * Group a markdown-it token stream into top-level blocks.
 *
 * The stream is flat and nesting is expressed by `nesting` (+1 open, -1 close).
 * A block is either one self-contained token (fence, hr, html_block, front
 * matter) or an open token through its matching close, with everything between
 * — so a list or a blockquote stays one block rather than fragmenting.
 *
 * @param {Array<object>} tokens
 * @returns {Array<Array<object>>}
 */
export function splitTopLevelBlocks(tokens) {
  const blocks = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.nesting === 1) {
      let depth = 1;
      let j = i + 1;
      while (j < tokens.length && depth > 0) {
        depth += tokens[j].nesting;
        j++;
      }
      blocks.push(tokens.slice(i, j));
      i = j;
    } else {
      blocks.push([token]);
      i += 1;
    }
  }
  return blocks;
}

/**
 * Render each top-level block to its own HTML string.
 *
 * The whole document is parsed once and every block is rendered every time —
 * that is the cheap part, and doing it wholesale keeps renderer state that
 * spans blocks (heading id de-duplication, reference definitions) consistent.
 * Only the DOM update is incremental.
 *
 * @param {object} md markdown-it instance
 * @param {string} text
 * @param {object} [env] shared render env; one object per document render
 * @returns {string[]} one HTML string per block
 */
export function renderBlockHtml(md, text, env = {}) {
  const tokens = md.parse(text, env);
  return splitTopLevelBlocks(tokens).map((block) => md.renderer.render(block, md.options, env));
}

/**
 * Locate the span that differs between two block lists.
 *
 * Trims the common prefix and the common suffix; whatever is left is replaced
 * wholesale. Editing is overwhelmingly one contiguous change, so this lands on
 * the minimal span in the normal case, and stays correct (just less minimal)
 * when edits are scattered.
 *
 * @param {string[]} prev
 * @param {string[]} next
 * @returns {{start: number, prevEnd: number, nextEnd: number}} half-open ranges;
 *   `start === prevEnd === nextEnd` means nothing changed
 */
export function diffRange(prev, next) {
  let start = 0;
  while (start < prev.length && start < next.length && prev[start] === next[start]) {
    start += 1;
  }
  let prevEnd = prev.length;
  let nextEnd = next.length;
  while (prevEnd > start && nextEnd > start && prev[prevEnd - 1] === next[nextEnd - 1]) {
    prevEnd -= 1;
    nextEnd -= 1;
  }
  return { start, prevEnd, nextEnd };
}

/**
 * Parse one block's HTML into a fragment, and report how many nodes it made.
 *
 * A block can yield several nodes: markdown-it emits a trailing newline after
 * most blocks, so `<p>x</p>\n` is an element plus a text node. Both belong to
 * the block and move together.
 */
function buildFragment(doc, html) {
  const tpl = doc.createElement('template');
  tpl.innerHTML = html;
  return { fragment: tpl.content, count: tpl.content.childNodes.length };
}

/**
 * Blocks are located by NODE COUNT, not by holding node references.
 *
 * The passes that run after a render rewrite the DOM in place: a diagram pass
 * does `pre.replaceWith(holder)`, so a reference captured at render time is
 * detached by the time the next edit arrives. Those rewrites are one-for-one,
 * so counts survive them and offsets stay valid.
 */
const totalNodes = (blocks) => blocks.reduce((n, b) => n + b.count, 0);
const offsetOf = (blocks, index) => totalNodes(blocks.slice(0, index));

/**
 * Build every block from scratch, replacing the container's children.
 *
 * @returns {Array<{html: string, count: number}>} the new block state
 */
export function buildAll(container, htmlList) {
  const doc = container.ownerDocument;
  container.textContent = '';
  const frag = doc.createDocumentFragment();
  const blocks = htmlList.map((html) => {
    const built = buildFragment(doc, html);
    frag.appendChild(built.fragment);
    return { html, count: built.count };
  });
  container.appendChild(frag);
  return blocks;
}

/**
 * Update the container so it matches `htmlList`, touching only the blocks whose
 * HTML changed.
 *
 * Falls back to a full rebuild whenever the container no longer holds the node
 * count the state expects. Several places clear the preview directly
 * (`innerHTML = ''` on tab close, the whole-file .puml/.mmd renderers), and
 * rather than teach every one of them to invalidate this state, an update that
 * cannot trust what it sees rebuilds instead.
 *
 * @param {HTMLElement} container
 * @param {Array<{html: string, count: number}>} prevBlocks state from the last update
 * @param {string[]} htmlList
 * @returns {{blocks: Array<{html: string, count: number}>, replaced: number, full: boolean}}
 *   `replaced` is how many blocks were rebuilt; 0 with `full: false` means the
 *   DOM was not touched at all.
 */
export function applyBlocks(container, prevBlocks, htmlList) {
  const doc = container.ownerDocument;

  if (!prevBlocks || container.childNodes.length !== totalNodes(prevBlocks)) {
    return { blocks: buildAll(container, htmlList), replaced: htmlList.length, full: true };
  }

  const { start, prevEnd, nextEnd } = diffRange(
    prevBlocks.map((b) => b.html),
    htmlList,
  );

  if (start === prevEnd && start === nextEnd) {
    return { blocks: prevBlocks, replaced: 0, full: false };
  }

  const from = offsetOf(prevBlocks, start);
  const removeCount = totalNodes(prevBlocks.slice(start, prevEnd));

  // Snapshot before removing: childNodes is live, so indices shift underneath.
  const doomed = [];
  for (let k = 0; k < removeCount; k++) doomed.push(container.childNodes[from + k]);
  for (const node of doomed) if (node) container.removeChild(node);

  const frag = doc.createDocumentFragment();
  const inserted = [];
  for (let i = start; i < nextEnd; i++) {
    const built = buildFragment(doc, htmlList[i]);
    frag.appendChild(built.fragment);
    inserted.push({ html: htmlList[i], count: built.count });
  }
  container.insertBefore(frag, container.childNodes[from] || null);

  return {
    blocks: [...prevBlocks.slice(0, start), ...inserted, ...prevBlocks.slice(prevEnd)],
    replaced: inserted.length,
    full: false,
  };
}
