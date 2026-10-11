// editor-past-end.js - the editor half of scroll-past-end.js: space below the
// last line, and a rule under that line while the view is scrolled into it.
import { EditorView, ViewPlugin, Decoration } from '@codemirror/view';
import { StateEffect } from '@codemirror/state';
import { isPastEnd, onScrollPastEndChange, pastEndSpace } from './scroll-past-end.js';

const refreshEffect = StateEffect.define();
const docEndDeco = Decoration.line({ class: 'cm-doc-end' });

/** Line decoration marking the last line of the document. */
export function docEndDecorations(state) {
  return Decoration.set([docEndDeco.range(state.doc.line(state.doc.lines).from)]);
}

/** Content attributes that add `space` px below the last line. */
export function pastEndAttrs(space) {
  return space > 0 ? { style: `padding-bottom: ${space}px` } : null;
}

const pastEndPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.view = view;
      this.space = 0;
      this.attrs = null;
      this.decorations = docEndDecorations(view.state);
      this.flag = this.flag.bind(this);
      view.scrollDOM.addEventListener('scroll', this.flag, { passive: true });
      // The pane's height is only known once it has been measured; until then
      // (and whenever the setting flips) ask for a fresh look.
      this.off = onScrollPastEndChange(() => view.dispatch({ effects: refreshEffect.of(null) }));
    }

    update(update) {
      if (update.docChanged) this.decorations = docEndDecorations(update.state);
      const asked = update.transactions.some((tr) => tr.effects.some((e) => e.is(refreshEffect)));
      if (!update.geometryChanged && !asked) return;
      const space = pastEndSpace(update.view.scrollDOM.clientHeight);
      if (space === this.space) return;
      this.space = space;
      this.attrs = pastEndAttrs(space);
      update.view.requestMeasure({ key: this, read: () => null, write: this.flag });
    }

    flag() {
      const scroller = this.view.scrollDOM;
      scroller.classList.toggle('is-past-end', isPastEnd(scroller, this.space));
    }

    destroy() {
      this.view.scrollDOM.removeEventListener('scroll', this.flag);
      this.view.scrollDOM.classList.remove('is-past-end');
      this.off();
    }
  },
  { decorations: (v) => v.decorations },
);

const pastEndTheme = EditorView.baseTheme({
  // Dashes drawn as a background so the line keeps its height (a border would
  // shift the text by a pixel every time the rule appears).
  '.cm-scroller.is-past-end .cm-doc-end': {
    backgroundImage:
      'repeating-linear-gradient(to right, var(--fg-muted, #888) 0 6px, transparent 6px 11px)',
    backgroundSize: '100% 1px',
    backgroundPosition: 'left bottom',
    backgroundRepeat: 'no-repeat',
  },
});

/**
 * Let the editor scroll past the end of the document by half its height.
 * Moving the cursor to the end still brings the last line to the bottom edge,
 * as before: only scrolling by hand reaches the space.
 */
export function scrollPastEnd() {
  return [
    pastEndPlugin,
    EditorView.contentAttributes.of((view) => view.plugin(pastEndPlugin)?.attrs || null),
    pastEndTheme,
  ];
}
