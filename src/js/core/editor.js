// editor.js - CodeMirror 6 editor management
import {
  EditorView,
  keymap,
  drawSelection,
  highlightActiveLine,
  lineNumbers,
} from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
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
export function createEditor(container, content = '', onChange = null, onScroll = null) {
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
    baseTheme,
    themeCompartment.of(
      document.documentElement.getAttribute('data-theme') === 'light' ? lightTheme : darkTheme,
    ),
    EditorView.lineWrapping,
  ];

  // Track IME composition state to avoid RangeError during Japanese input
  let composing = false;

  if (onChange) {
    extensions.push(
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !composing) {
          onChange(update.state.doc.toString());
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
      onScroll(ratio);
    });
  }

  return view;
}

export function setContent(view, content) {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
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
