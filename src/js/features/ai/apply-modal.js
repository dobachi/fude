// apply-modal.js - "Apply this revision to the document" preview & confirm.
//
// Opened from chat.js whenever the user clicks the Apply button on an AI
// code block. Shows a side-by-side Before/After preview, lets the user
// pick the apply target (current selection, whole document, insert at
// cursor), then dispatches a CodeMirror transaction.

let currentInstance = null;

/**
 * Open the apply preview modal.
 *
 * @param {object} opts
 * @param {string} opts.newText         The text the AI wants to apply.
 * @param {() => any} opts.getActiveView Callback returning the active CM view (so
 *                                       we always read the freshest selection
 *                                       state at apply time).
 * @returns {Promise<{ applied: boolean, target: string|null }>}
 */
export function openApplyModal(opts) {
  if (currentInstance) {
    currentInstance.cancel();
  }

  return new Promise((resolve) => {
    const getView = typeof opts.getActiveView === 'function' ? opts.getActiveView : () => null;
    const newText = String(opts.newText ?? '');

    // Snapshot of editor state at the moment we open. We re-read it on Apply
    // to handle the case where the user clicked back into the editor and
    // moved the cursor while the modal was open — but the preview itself
    // is rendered from this initial snapshot.
    const snapshot = readEditorState(getView());

    const overlay = document.createElement('div');
    overlay.className = 'apply-modal-overlay';
    overlay.innerHTML = `
      <div class="apply-modal" role="dialog" aria-label="Apply to document">
        <div class="apply-modal-header">
          <span class="apply-modal-title">Apply to document</span>
          <button class="apply-modal-close icon-btn" aria-label="Close" title="Close">×</button>
        </div>
        <div class="apply-modal-body">
          <fieldset class="apply-modal-target">
            <legend>Target</legend>
            <label>
              <input type="radio" name="apply-target" value="selection" ${snapshot.hasSelection ? '' : 'disabled'} />
              Replace selection
              <span class="apply-modal-target-hint">${snapshot.hasSelection ? `${snapshot.selectionLength} chars` : '(no selection)'}</span>
            </label>
            <label>
              <input type="radio" name="apply-target" value="cursor" />
              Insert at cursor
              <span class="apply-modal-target-hint">${snapshot.hasView ? `line ${snapshot.cursorLine}` : '(no editor)'}</span>
            </label>
            <label>
              <input type="radio" name="apply-target" value="document" />
              Replace entire document
              <span class="apply-modal-target-hint">${snapshot.hasView ? `${snapshot.docLength} chars` : '(no editor)'}</span>
            </label>
          </fieldset>
          <div class="apply-modal-preview">
            <div class="apply-modal-pane">
              <div class="apply-modal-pane-label">Before</div>
              <pre class="apply-modal-pane-content" data-side="before"></pre>
            </div>
            <div class="apply-modal-pane">
              <div class="apply-modal-pane-label">After</div>
              <pre class="apply-modal-pane-content" data-side="after"></pre>
            </div>
          </div>
        </div>
        <div class="apply-modal-footer">
          <span class="apply-modal-hint">Esc to cancel</span>
          <button class="apply-modal-cancel" type="button">Cancel</button>
          <button class="apply-modal-apply" type="button">Apply</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const beforePane = overlay.querySelector('[data-side="before"]');
    const afterPane = overlay.querySelector('[data-side="after"]');
    const radios = Array.from(overlay.querySelectorAll('input[name="apply-target"]'));
    const applyBtn = overlay.querySelector('.apply-modal-apply');
    const cancelBtn = overlay.querySelector('.apply-modal-cancel');
    const closeBtn = overlay.querySelector('.apply-modal-close');

    function close(result) {
      if (!overlay.isConnected) return;
      overlay.remove();
      document.removeEventListener('keydown', onKeyDown, true);
      if (currentInstance && currentInstance.overlay === overlay) currentInstance = null;
      resolve(result);
    }

    function cancel() {
      close({ applied: false, target: null });
    }

    currentInstance = { overlay, cancel };

    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) cancel();
    });
    closeBtn.addEventListener('click', cancel);
    cancelBtn.addEventListener('click', cancel);

    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        cancel();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        applyBtn.click();
      }
    }
    document.addEventListener('keydown', onKeyDown, true);

    // Default target: prefer the selection if one exists, otherwise insert
    // at cursor. Falling back to whole-document replace would be too
    // destructive as a default.
    const defaultTarget = pickDefaultTarget(snapshot);
    radios.forEach((r) => {
      r.checked = r.value === defaultTarget;
      r.addEventListener('change', refreshPreview);
    });

    function selectedTarget() {
      const checked = radios.find((r) => r.checked);
      return checked ? checked.value : defaultTarget;
    }

    function refreshPreview() {
      const target = selectedTarget();
      beforePane.textContent = beforeTextFor(target, snapshot);
      afterPane.textContent = afterTextFor(target, snapshot, newText);
    }
    refreshPreview();

    applyBtn.addEventListener('click', () => {
      const target = selectedTarget();
      const view = getView();
      if (!view) {
        close({ applied: false, target });
        return;
      }
      const liveSnapshot = readEditorState(view);
      applyToEditor(view, target, newText, liveSnapshot);
      close({ applied: true, target });
    });

    applyBtn.focus();
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────

function readEditorState(view) {
  if (!view) {
    return {
      hasView: false,
      hasSelection: false,
      selectionLength: 0,
      selectionText: '',
      selectionFrom: 0,
      selectionTo: 0,
      cursorPos: 0,
      cursorLine: 1,
      docLength: 0,
      docText: '',
    };
  }
  const state = view.state;
  const sel = state.selection.main;
  const cursorPos = sel.head;
  const docText = state.doc.toString();
  const selectionText = sel.from !== sel.to ? state.sliceDoc(sel.from, sel.to) : '';
  return {
    hasView: true,
    hasSelection: sel.from !== sel.to,
    selectionLength: sel.to - sel.from,
    selectionText,
    selectionFrom: sel.from,
    selectionTo: sel.to,
    cursorPos,
    cursorLine: state.doc.lineAt(cursorPos).number,
    docLength: state.doc.length,
    docText,
  };
}

export function pickDefaultTarget(snapshot) {
  if (snapshot.hasSelection) return 'selection';
  return 'cursor';
}

export function beforeTextFor(target, snapshot) {
  if (target === 'selection') return snapshot.selectionText || '';
  if (target === 'document') return snapshot.docText || '';
  // cursor insert: show a short context window around the insert point
  if (!snapshot.hasView) return '';
  const start = Math.max(0, snapshot.cursorPos - 80);
  const end = Math.min(snapshot.docLength, snapshot.cursorPos + 80);
  const left = snapshot.docText.slice(start, snapshot.cursorPos);
  const right = snapshot.docText.slice(snapshot.cursorPos, end);
  return `${left}│${right}`;
}

export function afterTextFor(target, snapshot, newText) {
  if (target === 'selection' || target === 'document') return newText;
  // cursor insert: show the same context window with newText spliced in.
  if (!snapshot.hasView) return newText;
  const start = Math.max(0, snapshot.cursorPos - 80);
  const end = Math.min(snapshot.docLength, snapshot.cursorPos + 80);
  const left = snapshot.docText.slice(start, snapshot.cursorPos);
  const right = snapshot.docText.slice(snapshot.cursorPos, end);
  return `${left}${newText}${right}`;
}

function applyToEditor(view, target, newText, snap) {
  if (!view || !view.state) return;
  const docLen = view.state.doc.length;
  let changes;
  if (target === 'selection' && snap.hasSelection) {
    changes = { from: snap.selectionFrom, to: snap.selectionTo, insert: newText };
  } else if (target === 'document') {
    changes = { from: 0, to: docLen, insert: newText };
  } else {
    // cursor (or selection requested but no selection available)
    const pos = Math.min(snap.cursorPos ?? 0, docLen);
    changes = { from: pos, insert: newText };
  }
  view.dispatch({
    changes,
    scrollIntoView: true,
  });
  view.focus();
}
