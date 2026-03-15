// context.js - Build context for AI requests from editor state

/**
 * Get the selected text and surrounding context from a CodeMirror EditorView.
 * @param {import('@codemirror/view').EditorView} view
 * @returns {{ selectedText: string, fullContent: string, selectionFrom: number, selectionTo: number }}
 */
export function getEditorContext(view) {
  const state = view.state;
  const { from, to } = state.selection.main;
  const selectedText = state.sliceDoc(from, to);
  const fullContent = state.doc.toString();

  return {
    selectedText,
    fullContent,
    selectionFrom: from,
    selectionTo: to,
  };
}
