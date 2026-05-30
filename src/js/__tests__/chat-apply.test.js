// Vitest covers the small pure helpers that drive the chat-to-document
// apply flow. We don't try to spin up CodeMirror here — the DOM-level
// glue lives behind `openApplyModal`/`enhanceCodeBlocksForApply` and is
// exercised by manual testing in the dev build.

import { describe, it, expect } from 'vitest';
import { buildChatSystemPrompt } from '../features/ai/chat.js';
import { pickDefaultTarget, beforeTextFor, afterTextFor } from '../features/ai/apply-modal.js';

describe('buildChatSystemPrompt', () => {
  it('returns a bare prompt with no editor context', () => {
    const p = buildChatSystemPrompt();
    expect(p).toContain('You are a helpful writing assistant');
    expect(p).not.toContain('selected the following text');
    expect(p).not.toContain('editing the following document');
    expect(p).not.toContain('fenced code block');
  });

  it('mentions the selection when one is supplied', () => {
    const p = buildChatSystemPrompt({ selectedText: 'hello world' });
    expect(p).toContain('hello world');
    expect(p).toContain('selected the following text');
  });

  it('mentions the document when context is enabled', () => {
    const p = buildChatSystemPrompt({ docContent: '# Title\n\nBody' });
    expect(p).toContain('# Title');
    expect(p).toContain('editing the following document');
  });

  it('adds the apply-button protocol guidance when any editor context is present', () => {
    expect(buildChatSystemPrompt({ selectedText: 'x' })).toMatch(
      /Apply to document|fenced code block/i,
    );
    expect(buildChatSystemPrompt({ docContent: 'doc' })).toMatch(
      /Apply to document|fenced code block/i,
    );
  });

  it('skips the apply-button protocol guidance for pure Q&A', () => {
    expect(buildChatSystemPrompt({})).not.toMatch(/Apply to document/i);
  });
});

describe('pickDefaultTarget', () => {
  it('prefers replacing the selection when one exists', () => {
    expect(pickDefaultTarget({ hasSelection: true })).toBe('selection');
  });
  it('falls back to insert-at-cursor when there is no selection', () => {
    expect(pickDefaultTarget({ hasSelection: false })).toBe('cursor');
  });
});

// 'say hello world to everyone.'  ← 28 chars, single spaces
//  0   4         15  16          27
const sampleSnapshot = {
  hasView: true,
  hasSelection: true,
  selectionLength: 11,
  selectionText: 'hello world',
  selectionFrom: 4,
  selectionTo: 15,
  cursorPos: 15,
  cursorLine: 1,
  docLength: 28,
  docText: 'say hello world to everyone.',
};

describe('beforeTextFor', () => {
  it('returns the selected text for the selection target', () => {
    expect(beforeTextFor('selection', sampleSnapshot)).toBe('hello world');
  });

  it('returns the full document for the document target', () => {
    expect(beforeTextFor('document', sampleSnapshot)).toBe(sampleSnapshot.docText);
  });

  it('shows a cursor marker in the local context for the cursor target', () => {
    const t = beforeTextFor('cursor', sampleSnapshot);
    expect(t).toContain('│');
    expect(t.split('│')[0]).toBe('say hello world');
  });

  it('is empty when there is no view', () => {
    expect(beforeTextFor('cursor', { hasView: false })).toBe('');
    expect(beforeTextFor('selection', { hasView: false })).toBe('');
    expect(beforeTextFor('document', { hasView: false })).toBe('');
  });
});

describe('afterTextFor', () => {
  it('replaces the selection text with the new text for selection target', () => {
    expect(afterTextFor('selection', sampleSnapshot, 'GREETINGS')).toBe('GREETINGS');
  });

  it('uses the new text alone for the document target', () => {
    expect(afterTextFor('document', sampleSnapshot, '# new doc')).toBe('# new doc');
  });

  it('splices the new text into the local context at the cursor', () => {
    const t = afterTextFor('cursor', sampleSnapshot, ' SPLICE');
    expect(t).toBe('say hello world SPLICE to everyone.');
  });

  it('falls back to just the new text when no view exists', () => {
    expect(afterTextFor('cursor', { hasView: false }, 'x')).toBe('x');
  });
});
