// inline-completion.js - Ghost text inline completion via CodeMirror
import { ViewPlugin, Decoration, WidgetType, EditorView, keymap } from '@codemirror/view';
import { StateField, StateEffect } from '@codemirror/state';
import { aiChatStream, getConfig } from '../../backend.js';
import { DEFAULT_MODEL } from './openrouter-client.js';

const DEBOUNCE_MS = 800;
const CONTEXT_CHARS = 500;

const setGhostText = StateEffect.define();
const clearGhostText = StateEffect.define();

class GhostTextWidget extends WidgetType {
  constructor(text) {
    super();
    this.text = text;
  }

  toDOM() {
    const span = document.createElement('span');
    span.className = 'ai-ghost-text';
    span.textContent = this.text;
    return span;
  }

  eq(other) {
    return this.text === other.text;
  }
}

const ghostTextField = StateField.define({
  create() {
    return { text: '', pos: 0 };
  },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setGhostText)) return e.value;
      if (e.is(clearGhostText)) return { text: '', pos: 0 };
    }
    if (tr.docChanged) return { text: '', pos: 0 };
    return value;
  },
});

const ghostTextDecoration = StateField.define({
  create() {
    return Decoration.none;
  },
  update(_, tr) {
    const ghost = tr.state.field(ghostTextField);
    if (!ghost.text || ghost.pos <= 0 || ghost.pos > tr.state.doc.length) {
      return Decoration.none;
    }
    return Decoration.set([
      Decoration.widget({
        widget: new GhostTextWidget(ghost.text),
        side: 1,
      }).range(ghost.pos),
    ]);
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * Create the inline completion extension.
 * Returns an array of extensions to add to the editor.
 */
export function inlineCompletionExtension() {
  let timer = null;
  let abortController = null;

  const plugin = ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
      }

      update(update) {
        if (!update.docChanged) return;

        if (timer) clearTimeout(timer);
        if (abortController) {
          abortController.abort();
          abortController = null;
        }

        this.view.dispatch({ effects: clearGhostText.of(null) });

        timer = setTimeout(() => {
          this.requestCompletion();
        }, DEBOUNCE_MS);
      }

      async requestCompletion() {
        const view = this.view;
        const { from, to } = view.state.selection.main;

        if (from !== to) return;

        const start = Math.max(0, from - CONTEXT_CHARS);
        const contextBefore = view.state.sliceDoc(start, from);

        if (!contextBefore.trim()) return;

        let config;
        try {
          config = await getConfig();
        } catch {
          return;
        }

        if (!config.features?.ai_copilot || !config.openrouter_api_key) return;

        const model = config.ai_model || DEFAULT_MODEL;
        abortController = new AbortController();

        const messages = [
          {
            role: 'system',
            content:
              'You are an inline text completion assistant for a Markdown editor. ' +
              'Given the text before the cursor, predict what the user will type next. ' +
              'Return ONLY the completion text (a few words to a sentence). ' +
              'Do not repeat the existing text. Do not add explanations.',
          },
          { role: 'user', content: contextBefore },
        ];

        let result = '';
        const cursorPos = from;

        try {
          await aiChatStream(
            messages,
            model,
            (chunk) => {
              result += chunk;
              if (result.length > 0) {
                view.dispatch({
                  effects: setGhostText.of({ text: result, pos: cursorPos }),
                });
              }
            },
            () => {},
            () => {},
            abortController.signal,
          );
        } catch {
          // ignore
        }
      }

      destroy() {
        if (timer) clearTimeout(timer);
        if (abortController) abortController.abort();
      }
    },
  );

  const completionKeymap = keymap.of([
    {
      key: 'Tab',
      run(view) {
        const ghost = view.state.field(ghostTextField);
        if (!ghost.text) return false;
        view.dispatch({
          changes: { from: ghost.pos, insert: ghost.text },
          effects: clearGhostText.of(null),
        });
        return true;
      },
    },
    {
      key: 'Escape',
      run(view) {
        const ghost = view.state.field(ghostTextField);
        if (!ghost.text) return false;
        view.dispatch({ effects: clearGhostText.of(null) });
        return true;
      },
    },
  ]);

  return [ghostTextField, ghostTextDecoration, plugin, completionKeymap];
}
