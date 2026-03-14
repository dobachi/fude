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
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';

const themeCompartment = new Compartment();
const keymodeCompartment = new Compartment();

let currentView = null;
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

export function createEditor(container, content = '', onChange = null) {
  if (currentView) {
    currentView.destroy();
  }

  container.innerHTML = '';

  const extensions = [
    lineNumbers(),
    highlightActiveLine(),
    drawSelection(),
    bracketMatching(),
    history(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    highlightSelectionMatches(),
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    autoListExtension(),
    boldKeymap(),
    baseTheme,
    themeCompartment.of(darkTheme),
    keymodeCompartment.of([]),
    EditorView.lineWrapping,
  ];

  if (onChange) {
    extensions.push(
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          onChange(update.state.doc.toString());
        }
      }),
    );
  }

  currentView = new EditorView({
    state: EditorState.create({ doc: content, extensions }),
    parent: container,
  });

  return currentView;
}

export function setContent(view, content) {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
}

export function getContent(view) {
  return view.state.doc.toString();
}

export function setTheme(view, theme) {
  const themeExt = theme === 'dark' ? darkTheme : lightTheme;
  view.dispatch({ effects: themeCompartment.reconfigure(themeExt) });
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

export async function toggleVim(view, enable) {
  if (enable) {
    try {
      const { vim } = await import('@replit/codemirror-vim');
      view.dispatch({ effects: keymodeCompartment.reconfigure(vim()) });
    } catch (e) {
      console.warn('Vim extension not available:', e);
    }
  } else {
    view.dispatch({ effects: keymodeCompartment.reconfigure([]) });
  }
}

export function getCurrentView() {
  return currentView;
}
