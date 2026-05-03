// editor.js - CodeMirror 6 editor management
import {
  EditorView,
  keymap,
  drawSelection,
  highlightActiveLine,
  lineNumbers,
} from '@codemirror/view';
import { EditorState, Compartment, Annotation } from '@codemirror/state';

// Marks transactions that replace document content from disk (file reload).
// Listeners use this to skip dirty-marking and autosave for these updates.
export const reloadAnnotation = Annotation.define();
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { defaultKeymap, indentWithTab, history, historyKeymap } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';

let currentFontSize = 14;

const baseTheme = EditorView.theme({
  '&': { height: '100%' },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--font-size)',
  },
});

const lightTheme = EditorView.theme({
  '.cm-content': { caretColor: '#000' },
  '&.cm-focused .cm-cursor': { borderLeftColor: '#000' },
});

const darkTheme = oneDark;

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

function boldKeymap() {
  return keymap.of([
    {
      key: 'Ctrl-b',
      run(view) {
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
        return true;
      },
    },
  ]);
}

/**
 * Create a new EditorView in the given container.
 * Each call creates an independent view; previous views are NOT destroyed.
 * The caller is responsible for destroying old views when needed.
 */
export function createEditor(container, content = '', onChange = null, onScroll = null, onSelectionChange = null) {
  container.innerHTML = '';

  const themeCompartment = new Compartment();
  const keymodeCompartment = new Compartment();

  const extensions = [
    // Vim mode FIRST - highest priority for key handling (ESC, Ctrl+[, etc.)
    keymodeCompartment.of([]),
    lineNumbers(),
    highlightActiveLine(),
    drawSelection(),
    bracketMatching(),
    history(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    highlightSelectionMatches(),
    markdown({ base: markdownLanguage, codeLanguages: languages }),
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
    baseTheme,
    themeCompartment.of(
      document.documentElement.getAttribute('data-theme') === 'light' ? lightTheme : darkTheme,
    ),
    EditorView.lineWrapping,
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

  // Track IME composition to suppress onChange during input
  view.contentDOM.addEventListener('compositionstart', () => { composing = true; });
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
  const themeExt = theme === 'dark' ? darkTheme : lightTheme;
  view.dispatch({ effects: view._themeCompartment.reconfigure(themeExt) });
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
  return { top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft };
}

export function setScroll(view, scroll) {
  if (scroll) {
    view.scrollDOM.scrollTop = scroll.top || 0;
    view.scrollDOM.scrollLeft = scroll.left || 0;
  }
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
    } catch { /* ignore */ }
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

export async function toggleVim(view, enable) {
  if (!view._keymodeCompartment) return;
  if (enable) {
    try {
      const { vim, Vim } = await import('@replit/codemirror-vim');
      view.dispatch({ effects: view._keymodeCompartment.reconfigure(vim()) });
      // ESC alternatives for browser compatibility
      Vim.map('<C-[>', '<Esc>', 'insert');
      Vim.map('<C-[>', '<Esc>', 'visual');
      Vim.map('jj', '<Esc>', 'insert');
      Vim.map('jk', '<Esc>', 'insert');
    } catch (e) {
      console.warn('Vim extension not available:', e);
    }
  } else {
    view.dispatch({ effects: view._keymodeCompartment.reconfigure([]) });
  }
}

export async function toggleEmacs(view, enable) {
  if (!view._keymodeCompartment) return;
  if (enable) {
    try {
      const { emacs } = await import('@replit/codemirror-emacs');
      view.dispatch({ effects: view._keymodeCompartment.reconfigure(emacs()) });
    } catch (e) {
      console.warn('Emacs extension not available:', e);
    }
  } else {
    view.dispatch({ effects: view._keymodeCompartment.reconfigure([]) });
  }
}
