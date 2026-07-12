// editor.js - CodeMirror 6 editor management
import {
  EditorView,
  keymap,
  drawSelection,
  highlightActiveLine,
  lineNumbers,
  Decoration,
} from '@codemirror/view';
import {
  EditorState,
  Compartment,
  Annotation,
  Prec,
  StateField,
  StateEffect,
} from '@codemirror/state';

// Marks transactions that replace document content from disk (file reload).
// Listeners use this to skip dirty-marking and autosave for these updates.
export const reloadAnnotation = Annotation.define();
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import {
  defaultKeymap,
  indentWithTab,
  history,
  historyKeymap,
  emacsStyleKeymap,
  cursorGroupBackward,
  cursorGroupForward,
  selectGroupBackward,
  selectGroupForward,
  cursorPageUp,
  selectPageUp,
  deleteGroupBackward,
  deleteGroupForward,
} from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search';
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  bracketMatching,
  HighlightStyle,
} from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { oneDark } from '@codemirror/theme-one-dark';
import { openExternal } from './external-link.js';
import { findTableAt, navigateTable, formatTableText, delimitedToModel } from './table.js';
import { shouldOpenAsCode, languageDescForPath } from './file-lang.js';

let currentFontSize = 14;

// Source code mode: when on, non-Markdown files open with their own language.
let sourceCodeModeEnabled = false;

/** Toggle source code mode (set from config). Affects editors created after. */
export function setSourceCodeMode(enabled) {
  sourceCodeModeEnabled = !!enabled;
}

// Match http(s) URLs and mailto: addresses inside editor text. The terminators
// keep us out of trailing markdown punctuation like ")" in [label](url).
const EDITOR_URL_RE = /(?:https?:\/\/|mailto:)[^\s<>()'"`\]]+/g;

// Scan a single line for the URL range that contains a given column.
// Returns { url, from, to } in absolute document offsets, or null.
function urlRangeAt(view, pos) {
  const line = view.state.doc.lineAt(pos);
  const col = pos - line.from;
  EDITOR_URL_RE.lastIndex = 0;
  let m;
  while ((m = EDITOR_URL_RE.exec(line.text)) !== null) {
    const start = m.index;
    const end = m.index + m[0].length;
    if (col >= start && col <= end) {
      // Trim common trailing punctuation that almost never belongs to URLs.
      let url = m[0];
      while (/[.,;:!?]$/.test(url)) url = url.slice(0, -1);
      return { url, from: line.from + start, to: line.from + start + url.length };
    }
  }
  return null;
}

const baseTheme = EditorView.theme({
  '&': { height: '100%' },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--font-size)',
  },
  // Transient highlight for a line we just jumped to (e.g. preview double-click).
  // Amber reads on both light and dark themes; the transition fades it out as
  // the decoration is cleared.
  '.cm-flash-line': {
    backgroundColor: 'rgba(255,193,7,0.38)',
    transition: 'background-color 0.6s ease-out',
  },
});

const lightTheme = EditorView.theme({
  '.cm-content': { caretColor: '#000' },
  '&.cm-focused .cm-cursor': { borderLeftColor: '#000' },
});

const darkTheme = oneDark;

// ===== Cyber Dark: neon-on-near-black =====
const cyberDarkHighlight = HighlightStyle.define([
  { tag: [t.heading, t.heading1, t.heading2, t.heading3], color: '#00e5ff', fontWeight: 'bold' },
  { tag: [t.heading4, t.heading5, t.heading6], color: '#22d3ee', fontWeight: 'bold' },
  { tag: t.strong, color: '#ff2bd6', fontWeight: 'bold' },
  { tag: t.emphasis, color: '#a6ffea', fontStyle: 'italic' },
  { tag: [t.link, t.url], color: '#3ee6ff', textDecoration: 'underline' },
  { tag: [t.monospace], color: '#7df9ff' },
  { tag: [t.list, t.processingInstruction], color: '#ff2bd6' },
  { tag: t.quote, color: '#7aa2c4', fontStyle: 'italic' },
  { tag: [t.keyword, t.modifier], color: '#ff2bd6' },
  { tag: [t.string, t.regexp], color: '#9dff8f' },
  { tag: [t.comment], color: '#4a6479', fontStyle: 'italic' },
  { tag: [t.number, t.bool, t.atom], color: '#ffb86c' },
  { tag: [t.typeName, t.className], color: '#00e5ff' },
  { tag: [t.variableName, t.propertyName], color: '#d6f0ff' },
]);

const cyberDarkTheme = [
  EditorView.theme(
    {
      '&': { color: '#d6f0ff', backgroundColor: '#0a0e17' },
      '.cm-content': { caretColor: '#00e5ff' },
      '&.cm-focused .cm-cursor': { borderLeftColor: '#00e5ff' },
      '.cm-gutters': { backgroundColor: '#0a0e17', color: '#3d566c', border: 'none' },
      '.cm-activeLine': { backgroundColor: 'rgba(0,229,255,0.05)' },
      '.cm-activeLineGutter': { backgroundColor: 'rgba(0,229,255,0.08)', color: '#7df9ff' },
      '.cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: 'rgba(0,229,255,0.18)',
      },
      '&.cm-focused .cm-selectionBackground': { backgroundColor: 'rgba(255,43,214,0.22)' },
      '.cm-searchMatch': { backgroundColor: 'rgba(255,43,214,0.25)' },
      '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgba(0,229,255,0.35)' },
    },
    { dark: true },
  ),
  syntaxHighlighting(cyberDarkHighlight),
];

// ===== Cyber Light: deep green on white (high contrast, flat) =====
const cyberLightHighlight = HighlightStyle.define([
  { tag: [t.heading, t.heading1, t.heading2, t.heading3], color: '#067016', fontWeight: 'bold' },
  { tag: [t.heading4, t.heading5, t.heading6], color: '#066314', fontWeight: 'bold' },
  { tag: t.strong, color: '#054d0f', fontWeight: 'bold' },
  { tag: t.emphasis, color: '#1e7a28', fontStyle: 'italic' },
  { tag: [t.link, t.url], color: '#066314', textDecoration: 'underline' },
  { tag: [t.monospace], color: '#0a5c30' },
  { tag: [t.list, t.processingInstruction], color: '#067016' },
  { tag: t.quote, color: '#33623a', fontStyle: 'italic' },
  { tag: [t.keyword, t.modifier], color: '#054d0f' },
  { tag: [t.string, t.regexp], color: '#0f7026' },
  { tag: [t.comment], color: '#5a7d60', fontStyle: 'italic' },
  { tag: [t.number, t.bool, t.atom], color: '#0a5c10' },
  { tag: [t.typeName, t.className], color: '#067016' },
  { tag: [t.variableName, t.propertyName], color: '#06340e' },
]);

const cyberLightTheme = [
  EditorView.theme(
    {
      '&': { color: '#06340e', backgroundColor: '#ffffff' },
      '.cm-content': { caretColor: '#067016' },
      '&.cm-focused .cm-cursor': { borderLeftColor: '#067016' },
      '.cm-gutters': { backgroundColor: '#ffffff', color: '#5a7d60', border: 'none' },
      '.cm-activeLine': { backgroundColor: 'rgba(7,90,20,0.08)' },
      '.cm-activeLineGutter': { backgroundColor: 'rgba(7,90,20,0.14)', color: '#067016' },
      '.cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: 'rgba(7,90,20,0.18)',
      },
      '&.cm-focused .cm-selectionBackground': { backgroundColor: 'rgba(7,90,20,0.26)' },
      '.cm-searchMatch': { backgroundColor: 'rgba(7,90,20,0.22)' },
      '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgba(15,157,42,0.38)' },
    },
    { dark: false },
  ),
  syntaxHighlighting(cyberLightHighlight),
];

// Map a data-theme name to the CodeMirror theme extension(s) it should use.
function themeExtensionFor(name) {
  switch (name) {
    case 'light':
      return lightTheme;
    case 'cyber-dark':
      return cyberDarkTheme;
    case 'cyber-light':
      return cyberLightTheme;
    case 'dark':
    default:
      return darkTheme;
  }
}

function autoListExtension() {
  return keymap.of([
    {
      key: 'Enter',
      run(view) {
        const { state } = view;
        const { from } = state.selection.main;
        const line = state.doc.lineAt(from);
        const text = line.text;

        const bulletMatch = text.match(/^(\s*)([-*+])\s/);
        const numberedMatch = text.match(/^(\s*)(\d+)\.\s/);

        if (bulletMatch) {
          const [, indent, bullet] = bulletMatch;
          if (text.trim() === `${bullet}`) {
            view.dispatch({ changes: { from: line.from, to: line.to, insert: '' } });
            return true;
          }
          view.dispatch(state.replaceSelection(`\n${indent}${bullet} `), { scrollIntoView: true });
          return true;
        }

        if (numberedMatch) {
          const [, indent, num] = numberedMatch;
          if (text.trim() === `${num}.`) {
            view.dispatch({ changes: { from: line.from, to: line.to, insert: '' } });
            return true;
          }
          const next = parseInt(num, 10) + 1;
          view.dispatch(state.replaceSelection(`\n${indent}${next}. `), { scrollIntoView: true });
          return true;
        }

        return false;
      },
    },
  ]);
}

function selectedLines(state) {
  const { from, to } = state.selection.main;
  const startLine = state.doc.lineAt(from);
  const endLine = state.doc.lineAt(to);
  const lines = [];
  for (let i = startLine.number; i <= endLine.number; i++) {
    lines.push(state.doc.line(i));
  }
  return lines;
}

const BULLET_RE = /^(\s*)([-*+])\s/;
const NUMBERED_RE = /^(\s*)(\d+)\.\s/;

export function computeBulletToggle(state) {
  const lines = selectedLines(state);
  const nonEmpty = lines.filter((l) => l.text.trim() !== '');
  if (nonEmpty.length === 0) return null;

  const allBulleted = nonEmpty.every((l) => BULLET_RE.test(l.text));
  const changes = [];

  if (allBulleted) {
    for (const line of nonEmpty) {
      const match = line.text.match(BULLET_RE);
      const indent = match[1];
      changes.push({
        from: line.from + indent.length,
        to: line.from + indent.length + 2,
        insert: '',
      });
    }
  } else {
    for (const line of nonEmpty) {
      if (BULLET_RE.test(line.text)) continue;
      const indent = line.text.match(/^(\s*)/)[1];
      const numMatch = line.text.match(NUMBERED_RE);
      if (numMatch) {
        const markerLen = numMatch[0].length - indent.length;
        changes.push({
          from: line.from + indent.length,
          to: line.from + indent.length + markerLen,
          insert: '- ',
        });
      } else {
        changes.push({ from: line.from + indent.length, insert: '- ' });
      }
    }
  }
  if (changes.length === 0) return null;
  return { changes };
}

export function computeNumberedToggle(state) {
  const lines = selectedLines(state);
  const nonEmpty = lines.filter((l) => l.text.trim() !== '');
  if (nonEmpty.length === 0) return null;

  const allNumbered = nonEmpty.every((l) => NUMBERED_RE.test(l.text));
  const changes = [];

  if (allNumbered) {
    for (const line of nonEmpty) {
      const match = line.text.match(NUMBERED_RE);
      const indent = match[1];
      const markerLen = match[0].length - indent.length;
      changes.push({
        from: line.from + indent.length,
        to: line.from + indent.length + markerLen,
        insert: '',
      });
    }
  } else {
    let n = 1;
    for (const line of nonEmpty) {
      const indent = line.text.match(/^(\s*)/)[1];
      const numMatch = line.text.match(NUMBERED_RE);
      const bulletMatch = line.text.match(BULLET_RE);
      if (numMatch) {
        const markerLen = numMatch[0].length - indent.length;
        changes.push({
          from: line.from + indent.length,
          to: line.from + indent.length + markerLen,
          insert: `${n}. `,
        });
      } else if (bulletMatch) {
        changes.push({
          from: line.from + indent.length,
          to: line.from + indent.length + 2,
          insert: `${n}. `,
        });
      } else {
        changes.push({ from: line.from + indent.length, insert: `${n}. ` });
      }
      n++;
    }
  }
  if (changes.length === 0) return null;
  return { changes };
}

function listKeymap() {
  return keymap.of([
    {
      key: 'Ctrl-Shift-8',
      run(view) {
        const tr = computeBulletToggle(view.state);
        if (!tr) return false;
        view.dispatch(tr);
        return true;
      },
    },
    {
      key: 'Ctrl-Shift-7',
      run(view) {
        const tr = computeNumberedToggle(view.state);
        if (!tr) return false;
        view.dispatch(tr);
        return true;
      },
    },
  ]);
}

/**
 * Toggle bold (`**...**`) around the selection. Exposed so the menu bar and the
 * Ctrl-B keybinding share one implementation.
 */
export function toggleBold(view) {
  if (!view) return false;
  const { state } = view;
  const { from, to } = state.selection.main;
  const selected = state.sliceDoc(from, to);

  if (selected.startsWith('**') && selected.endsWith('**') && selected.length >= 4) {
    view.dispatch({ changes: { from, to, insert: selected.slice(2, -2) } });
  } else if (
    from >= 2 &&
    state.sliceDoc(from - 2, from) === '**' &&
    state.sliceDoc(to, to + 2) === '**'
  ) {
    view.dispatch({
      changes: [
        { from: from - 2, to: from, insert: '' },
        { from: to, to: to + 2, insert: '' },
      ],
    });
  } else {
    view.dispatch({
      changes: { from, to, insert: `**${selected}**` },
      selection: { anchor: from + 2, head: to + 2 },
    });
  }
  view.focus();
  return true;
}

/** Toggle a bullet list on the selected lines (menu + keymap shared). */
export function toggleBullet(view) {
  if (!view) return false;
  const tr = computeBulletToggle(view.state);
  if (!tr) return false;
  view.dispatch(tr);
  view.focus();
  return true;
}

/** Toggle a numbered list on the selected lines (menu + keymap shared). */
export function toggleNumbered(view) {
  if (!view) return false;
  const tr = computeNumberedToggle(view.state);
  if (!tr) return false;
  view.dispatch(tr);
  view.focus();
  return true;
}

/** Open the search/replace panel for the given view. */
export function openSearch(view) {
  if (!view) return false;
  return openSearchPanel(view);
}

function boldKeymap() {
  return keymap.of([{ key: 'Ctrl-b', run: toggleBold }]);
}

// ── Table editing ──────────────────────────────────────────
// All table logic lives in table.js (pure, tested). These thin wrappers map
// between document offsets and the table block, then dispatch the change.

/** Char range [from, to] of the table block at the cursor, or null. */
function tableBlockRange(state) {
  const { from, to } = state.selection.main;
  if (from !== to) return null; // only a collapsed cursor navigates cells
  const lineIdx = state.doc.lineAt(from).number - 1;
  const block = findTableAt(state.doc.toString(), lineIdx);
  if (!block) return null;
  const startLine = state.doc.line(block.startLine + 1);
  const endLine = state.doc.line(block.endLine + 1);
  return { block, from: startLine.from, to: endLine.to, cursor: from };
}

/** Move between table cells (direction: 'next' | 'prev' | 'down'), reformatting. */
function tableNav(view, direction) {
  const range = tableBlockRange(view.state);
  if (!range) return false;
  const blockText = view.state.sliceDoc(range.from, range.to);
  const res = navigateTable(blockText, range.cursor - range.from, direction);
  if (!res) return false;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: res.text },
    selection: { anchor: range.from + res.cursor },
    scrollIntoView: true,
  });
  return true;
}

/** Reformat (align) the table at the cursor without moving cells. */
function tableFormat(view) {
  const range = tableBlockRange(view.state);
  if (!range) return false;
  const formatted = formatTableText(range.block.model);
  if (formatted !== view.state.sliceDoc(range.from, range.to)) {
    view.dispatch({ changes: { from: range.from, to: range.to, insert: formatted } });
  }
  return true;
}

function tableKeymap() {
  return keymap.of([
    { key: 'Tab', run: (v) => tableNav(v, 'next') },
    { key: 'Shift-Tab', run: (v) => tableNav(v, 'prev') },
    { key: 'Enter', run: (v) => tableNav(v, 'down') },
    { key: 'Mod-Shift-f', run: tableFormat },
  ]);
}

/**
 * Create a new EditorView in the given container.
 * Each call creates an independent view; previous views are NOT destroyed.
 * The caller is responsible for destroying old views when needed.
 */
export function createEditor(
  container,
  content = '',
  onChange = null,
  onScroll = null,
  onSelectionChange = null,
  opts = {},
) {
  container.innerHTML = '';

  const themeCompartment = new Compartment();
  const keymodeCompartment = new Compartment();
  const languageCompartment = new Compartment();

  // Markdown is the default language. In source code mode, a non-Markdown file
  // starts as plain text (no Markdown mis-parsing flash) and swaps to its real
  // language once the parser is lazily loaded below.
  const markdownLang = markdown({ base: markdownLanguage, codeLanguages: languages });
  const asCode = shouldOpenAsCode(opts.filePath, sourceCodeModeEnabled);
  const initialLang = asCode ? [] : markdownLang;

  const extensions = [
    // Vim mode FIRST - highest priority for key handling (ESC, Ctrl+[, etc.)
    keymodeCompartment.of([]),
    // Required for vim visual block (Ctrl-V) operations: without this, CM6
    // collapses the multi-range selection that visual block produces, so
    // delete/yank/etc. only affect the primary range.
    EditorState.allowMultipleSelections.of(true),
    lineNumbers(),
    highlightActiveLine(),
    drawSelection(),
    bracketMatching(),
    history(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    highlightSelectionMatches(),
    flashLineField,
    languageCompartment.of(initialLang),
    keymap.of([
      {
        key: 'Ctrl-d',
        run(view) {
          const amount = view.dom.clientHeight / 2;
          view.scrollDOM.scrollTop += amount;
          return true;
        },
      },
      {
        key: 'Ctrl-u',
        run(view) {
          const amount = view.dom.clientHeight / 2;
          view.scrollDOM.scrollTop -= amount;
          return true;
        },
      },
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      indentWithTab,
    ]),
    autoListExtension(),
    boldKeymap(),
    listKeymap(),
    // Prec.high so the table's Tab/Enter run before indentWithTab / the default
    // keymap (which otherwise win), but still below vim/emacs (Prec.highest).
    // The handlers return false outside a table, falling through to those.
    Prec.high(tableKeymap()),
    baseTheme,
    themeCompartment.of(themeExtensionFor(document.documentElement.getAttribute('data-theme'))),
    EditorView.lineWrapping,
    EditorView.domEventHandlers({
      paste(event, view) {
        const items = event.clipboardData?.items;
        // 1. Image paste (existing behavior). Extract File objects synchronously:
        // clipboardData (and getAsFile) become invalid once this handler returns.
        if (_imagePasteHandler && items) {
          const images = [];
          for (const it of items) {
            if (it.type?.startsWith('image/')) {
              const f = it.getAsFile();
              if (f) images.push({ file: f, type: it.type });
            }
          }
          if (images.length > 0) {
            event.preventDefault();
            _imagePasteHandler(view, images);
            return true;
          }
        }
        // 2. Tabular text (TSV / CSV) -> Markdown table.
        const text = event.clipboardData?.getData('text/plain');
        if (text) {
          const model = delimitedToModel(text);
          if (model) {
            const { state } = view;
            const { from, to } = state.selection.main;
            const line = state.doc.lineAt(from);
            const before = state.sliceDoc(line.from, from);
            const after = state.sliceDoc(to, state.doc.lineAt(to).to);
            let insert = formatTableText(model);
            if (before.trim() !== '') insert = '\n' + insert;
            if (after.trim() !== '') insert = insert + '\n';
            event.preventDefault();
            view.dispatch(state.replaceSelection(insert), { scrollIntoView: true });
            return true;
          }
        }
        return false;
      },
    }),
  ];

  // Track IME composition state to avoid RangeError during Japanese input
  let composing = false;

  if (onChange || onSelectionChange) {
    extensions.push(
      EditorView.updateListener.of((update) => {
        const isReload = update.transactions.some((tr) => tr.annotation(reloadAnnotation));
        if (onChange && update.docChanged && !composing && !isReload) {
          onChange(update.state.doc.toString());
        }
        if (onSelectionChange && update.selectionSet) {
          const { from, to } = update.state.selection.main;
          const selectedText = from !== to ? update.state.sliceDoc(from, to) : '';
          onSelectionChange(selectedText);
        }
      }),
    );
  }

  const view = new EditorView({
    state: EditorState.create({ doc: content, extensions }),
    parent: container,
  });

  // Store compartment references on the view for later reconfiguration
  view._themeCompartment = themeCompartment;
  view._keymodeCompartment = keymodeCompartment;
  view._languageCompartment = languageCompartment;

  // Source code mode: lazily load the file's language parser and swap it into
  // the language compartment. The editor was created as plain text above, so
  // there's no Markdown flash; highlighting appears once the parser resolves.
  if (asCode) {
    const desc = languageDescForPath(opts.filePath);
    if (desc) {
      Promise.resolve(desc.load())
        .then((support) => {
          if (!view.dom || !view.dom.isConnected) return;
          view.dispatch({ effects: languageCompartment.reconfigure(support) });
        })
        .catch(() => {
          /* unknown/failed language → stays plain text */
        });
    }
  }

  // Ctrl/Cmd + click on a URL in the source opens it in the OS browser.
  // Listen on the outer dom so coordinates resolve correctly across wrapped
  // lines. Use mousedown (capture) so we can suppress CodeMirror's caret move
  // and selection update before they happen.
  view.dom.addEventListener(
    'mousedown',
    (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.button !== 0) return;
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos == null) return;
      const hit = urlRangeAt(view, pos);
      if (!hit) return;
      e.preventDefault();
      e.stopPropagation();
      openExternal(hit.url);
    },
    true,
  );

  // Track IME composition to suppress onChange during input
  view.contentDOM.addEventListener('compositionstart', () => {
    composing = true;
  });
  view.contentDOM.addEventListener('compositionend', () => {
    composing = false;
    // Fire onChange after composition completes
    if (onChange) onChange(view.state.doc.toString());
  });

  if (onScroll) {
    view.scrollDOM.addEventListener('scroll', () => {
      const { scrollTop, scrollHeight, clientHeight } = view.scrollDOM;
      const maxScroll = scrollHeight - clientHeight;
      const ratio = maxScroll > 0 ? scrollTop / maxScroll : 0;
      // Compute the visible top line for content-aware sync (fractional)
      let topLine = 1;
      try {
        const block = view.lineBlockAtHeight(scrollTop);
        const lineNum = view.state.doc.lineAt(block.from).number;
        const blockHeight = block.bottom - block.top;
        const offsetIntoBlock = scrollTop - block.top;
        const fraction = blockHeight > 0 ? offsetIntoBlock / blockHeight : 0;
        topLine = lineNum + fraction;
      } catch {
        /* best-effort; fall back to ratio */
      }
      onScroll({ ratio, topLine });
    });
  }

  return view;
}

export function setContent(view, content) {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
}

/**
 * Replace document content from disk while preserving cursor (by line/column)
 * and scroll position. The transaction is annotated so listeners (onChange,
 * autosave) skip it.
 */
export function setContentFromDisk(view, content) {
  const scrollTop = view.scrollDOM.scrollTop;
  const scrollLeft = view.scrollDOM.scrollLeft;

  const { from: oldPos } = view.state.selection.main;
  const oldLine = view.state.doc.lineAt(oldPos);
  const oldLineNum = oldLine.number;
  const oldColumn = oldPos - oldLine.from;

  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: content },
    annotations: reloadAnnotation.of(true),
  });

  const newDoc = view.state.doc;
  const targetLineNum = Math.min(oldLineNum, newDoc.lines);
  const targetLine = newDoc.line(targetLineNum);
  const targetPos = Math.min(targetLine.from + oldColumn, targetLine.to);
  view.dispatch({
    selection: { anchor: targetPos },
    annotations: reloadAnnotation.of(true),
  });

  requestAnimationFrame(() => {
    view.scrollDOM.scrollTop = scrollTop;
    view.scrollDOM.scrollLeft = scrollLeft;
  });
}

export function getContent(view) {
  return view.state.doc.toString();
}

export function setTheme(view, theme) {
  if (!view._themeCompartment) return;
  view.dispatch({ effects: view._themeCompartment.reconfigure(themeExtensionFor(theme)) });
}

export function getCursor(view) {
  const pos = view.state.selection.main;
  return { from: pos.from, to: pos.to };
}

export function setCursor(view, from, to = from) {
  const docLen = view.state.doc.length;
  const safeFrom = Math.min(from, docLen);
  const safeTo = Math.min(to, docLen);
  view.dispatch({ selection: { anchor: safeFrom, head: safeTo } });
}

export function getScroll(view) {
  const scrollTop = view.scrollDOM.scrollTop;
  // Capture the (fractional, 1-based) top line in addition to pixels. Pixel
  // scrollTop is width-dependent (line wrap), so restoring it after a view-mode
  // change lands on the wrong line; the line number is width-independent.
  let line = 1;
  try {
    const block = view.lineBlockAtHeight(scrollTop);
    const lineNum = view.state.doc.lineAt(block.from).number;
    const blockHeight = block.bottom - block.top;
    const fraction = blockHeight > 0 ? (scrollTop - block.top) / blockHeight : 0;
    line = lineNum + Math.max(0, Math.min(1, fraction));
  } catch {
    /* layout race — fall back to line 1 */
  }
  return { top: scrollTop, left: view.scrollDOM.scrollLeft, line };
}

export function setScroll(view, scroll) {
  if (!view || !scroll) return;
  // Prefer width-independent line-based restore when available.
  if (typeof scroll.line === 'number') {
    scrollEditorToLine(view, scroll.line);
    if (scroll.left) view.scrollDOM.scrollLeft = scroll.left;
    return;
  }
  view.scrollDOM.scrollTop = scroll.top || 0;
  view.scrollDOM.scrollLeft = scroll.left || 0;
}

// ── Line flash (transient highlight after a jump) ─────────────
// A one-shot line decoration used to draw the eye to the line we just jumped
// to (e.g. from a preview double-click). It clears itself after FLASH_MS.
const FLASH_MS = 800;
const flashLineEffect = StateEffect.define(); // value: line-start pos, or null to clear
const flashLineDeco = Decoration.line({ class: 'cm-flash-line' });
const flashLineField = StateField.define({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(flashLineEffect)) {
        deco = e.value == null ? Decoration.none : Decoration.set([flashLineDeco.range(e.value)]);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * Briefly highlight the given 1-based line, then clear it. Purely visual —
 * used to show where a jump (e.g. from the preview) landed.
 */
export function flashLine(view, line) {
  if (!view) return;
  const docLines = view.state.doc.lines;
  const safe = Math.max(1, Math.min(Math.floor(line), docLines));
  const pos = view.state.doc.line(safe).from;
  view.dispatch({ effects: flashLineEffect.of(pos) });
  setTimeout(() => {
    try {
      view.dispatch({ effects: flashLineEffect.of(null) });
    } catch {
      /* view destroyed before the flash cleared — ignore */
    }
  }, FLASH_MS);
}

/**
 * Move the cursor to the start of the given 1-based line, scroll that line to
 * the top of the viewport, and focus the editor. Used by the outline panel
 * for "jump to heading".
 */
export function jumpToLine(view, line) {
  if (!view) return;
  const docLines = view.state.doc.lines;
  const safe = Math.max(1, Math.min(Math.floor(line), docLines));
  const pos = view.state.doc.line(safe).from;
  view.dispatch({ selection: { anchor: pos } });
  scrollEditorToLine(view, safe);
  view.focus();
}

/**
 * Scroll the editor so that the given (fractional, 1-based) line is at the top.
 */
export function scrollEditorToLine(view, line) {
  if (!view) return;
  const docLines = view.state.doc.lines;
  const lineNum = Math.max(1, Math.min(Math.floor(line), docLines));
  const fraction = Math.max(0, Math.min(1, line - lineNum));
  try {
    const block = view.lineBlockAt(view.state.doc.line(lineNum).from);
    const blockHeight = block.bottom - block.top;
    view.scrollDOM.scrollTop = block.top + blockHeight * fraction;
  } catch {
    /* no-op on layout race */
  }
}

export function setFontSize(size) {
  currentFontSize = size;
  document.documentElement.style.setProperty('--font-size', `${size}px`);
}

export function getFontSize() {
  return currentFontSize;
}

/**
 * Get the currently active EditorView (from the active pane).
 * Uses lazy import to avoid circular dependency with panes.js.
 */
export function getCurrentView() {
  // Lazy-resolve to avoid circular import at module evaluation time
  if (!_getActivePaneView) {
    try {
      // eslint-disable-next-line no-eval
      const mod = _panesModule;
      if (mod) _getActivePaneView = mod.getActivePaneView;
    } catch {
      /* ignore */
    }
  }
  return _getActivePaneView ? _getActivePaneView() : null;
}

let _getActivePaneView = null;
let _panesModule = null;

/**
 * Register the panes module so getCurrentView() can resolve without circular imports.
 * Called once from app.js after both modules are loaded.
 */
export function registerPanesModule(mod) {
  _panesModule = mod;
  _getActivePaneView = mod.getActivePaneView;
}

// Handler invoked when an image is pasted into the editor. Set by app.js, which
// knows the active document path. Receives (view, items: DataTransferItemList)
// and returns true if it consumed the paste (caller then prevents default).
let _imagePasteHandler = null;

/** Register the image-paste handler. Called once from app.js. */
export function registerImagePasteHandler(fn) {
  _imagePasteHandler = fn;
}

// Statically import vim/emacs so they're always bundled and initialized at load.
// Earlier dynamic imports occasionally failed silently in Windows WebView2 builds.
import { vim, Vim } from '@replit/codemirror-vim';
import { emacs, EmacsHandler } from '@replit/codemirror-emacs';

let vimMapsRegistered = false;

// Emacs-native save: C-x C-s. The actual save is an app action, so editor.js
// just exposes a hook that app.js fills in with its save function.
let _saveHandler = null;
/** Register the app's save function so Emacs C-x C-s can trigger it. */
export function registerSaveHandler(fn) {
  _saveHandler = fn;
}
EmacsHandler.addCommands({
  fudeSaveBuffer: {
    exec() {
      if (_saveHandler) _saveHandler();
    },
    readOnly: true,
  },
});
EmacsHandler.bindKey('C-x C-s', 'fudeSaveBuffer');

export function toggleVim(view, enable) {
  if (!view._keymodeCompartment) return;
  if (enable) {
    // Prec.highest ensures vim's keymap takes precedence over defaultKeymap (selectAll, etc.)
    view.dispatch({ effects: view._keymodeCompartment.reconfigure(Prec.highest(vim())) });
    if (!vimMapsRegistered) {
      // ESC alternatives for browser compatibility (global Vim state)
      Vim.map('<C-[>', '<Esc>', 'insert');
      Vim.map('<C-[>', '<Esc>', 'visual');
      Vim.map('jj', '<Esc>', 'insert');
      Vim.map('jk', '<Esc>', 'insert');
      vimMapsRegistered = true;
    }
  } else {
    view.dispatch({ effects: view._keymodeCompartment.reconfigure([]) });
  }
}

// Alt-prefixed Emacs bindings that emacsStyleKeymap doesn't include but users expect.
// These complement Ctrl-* in the fallback so we don't depend on @replit/codemirror-emacs's
// ViewPlugin firing on every key (which appeared unreliable on Windows WebView2).
const emacsAltKeymap = [
  { key: 'Alt-b', run: cursorGroupBackward, shift: selectGroupBackward },
  { key: 'Alt-f', run: cursorGroupForward, shift: selectGroupForward },
  { key: 'Alt-v', run: cursorPageUp, shift: selectPageUp },
  { key: 'Alt-d', run: deleteGroupForward },
  { key: 'Alt-Backspace', run: deleteGroupBackward },
  {
    // Emacs M-w: kill-ring-save = copy region without deleting
    key: 'Alt-w',
    run(view) {
      const { from, to } = view.state.selection.main;
      if (from === to) return false;
      const text = view.state.sliceDoc(from, to);
      try {
        navigator.clipboard.writeText(text);
      } catch {
        /* clipboard may be unavailable */
      }
      return true;
    },
  },
];

// Ctrl-S (isearch) and Ctrl-W (kill region) aren't in emacsStyleKeymap but
// users in Emacs mode expect them. Add as fallback so they work even if the
// @replit/codemirror-emacs ViewPlugin isn't dispatching.
const emacsExtraCtrlKeymap = [
  { key: 'Ctrl-s', run: openSearchPanel },
  { key: 'Ctrl-r', run: openSearchPanel }, // CodeMirror's panel handles both directions
  {
    key: 'Ctrl-w',
    run(view) {
      const { from, to } = view.state.selection.main;
      if (from === to) return false; // nothing selected → no-op
      const text = view.state.sliceDoc(from, to);
      try {
        navigator.clipboard.writeText(text);
      } catch {
        /* clipboard may be unavailable; still delete */
      }
      view.dispatch({
        changes: { from, to, insert: '' },
        selection: { anchor: from },
      });
      return true;
    },
  },
];

export function toggleEmacs(view, enable) {
  if (!view._keymodeCompartment) return;
  if (enable) {
    // Layered at highest precedence:
    //   1. emacs() ViewPlugin from @replit/codemirror-emacs (full experience)
    //   2. emacsStyleKeymap (Ctrl-A/B/E/F/N/P/D/H/K/T/V) — defensive fallback
    //   3. emacsAltKeymap (Alt-B/F/V/D/Backspace) — Alt bindings missing from #2
    //   4. emacsExtraCtrlKeymap (Ctrl-S/R/W) — Emacs Ctrl bindings missing from #2
    view.dispatch({
      effects: view._keymodeCompartment.reconfigure(
        Prec.highest([
          emacs(),
          keymap.of([...emacsStyleKeymap, ...emacsAltKeymap, ...emacsExtraCtrlKeymap]),
        ]),
      ),
    });
  } else {
    view.dispatch({ effects: view._keymodeCompartment.reconfigure([]) });
  }
}
