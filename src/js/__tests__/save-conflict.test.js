import { describe, it, expect, beforeEach } from 'vitest';
import { shouldWarnConflict, renderDiff, showConflictDialog } from '../core/save-conflict.js';
import { diffLines } from '../core/line-diff.js';

describe('shouldWarnConflict', () => {
  const base = {
    loadedHash: 'h1',
    currentDiskHash: 'h2',
    diskContent: 'disk',
    editorContent: 'editor',
  };

  it('warns when disk changed and differs from the editor', () => {
    expect(shouldWarnConflict(base)).toBe(true);
  });

  it('does not warn without a baseline (new/unsynced file)', () => {
    expect(shouldWarnConflict({ ...base, loadedHash: null })).toBe(false);
  });

  it('does not warn when disk is unchanged since load', () => {
    expect(shouldWarnConflict({ ...base, currentDiskHash: 'h1' })).toBe(false);
  });

  it('does not warn when disk already equals what we would write', () => {
    expect(shouldWarnConflict({ ...base, diskContent: 'same', editorContent: 'same' })).toBe(false);
  });
});

describe('renderDiff', () => {
  it('builds prefixed, class-tagged lines', () => {
    const frag = renderDiff(diffLines('a\nb', 'a\nc'));
    const div = document.createElement('div');
    div.appendChild(frag);
    const lines = [...div.children].map((el) => ({ cls: el.className, text: el.textContent }));
    expect(lines).toContainEqual({ cls: 'diff-equal', text: '  a' });
    expect(lines).toContainEqual({ cls: 'diff-del', text: '- b' });
    expect(lines).toContainEqual({ cls: 'diff-add', text: '+ c' });
  });
});

describe('showConflictDialog', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('fires onOverwrite and removes the dialog', () => {
    let called = '';
    showConflictDialog({
      fileName: 'note.md',
      diskContent: 'a',
      editorContent: 'b',
      onOverwrite: () => (called = 'overwrite'),
      onReload: () => (called = 'reload'),
      onCancel: () => (called = 'cancel'),
    });
    document.querySelector('.btn-overwrite').click();
    expect(called).toBe('overwrite');
    expect(document.querySelector('.save-conflict-overlay')).toBeNull();
  });

  it('fires onReload', () => {
    let called = '';
    showConflictDialog({
      fileName: 'note.md',
      diskContent: 'a',
      editorContent: 'b',
      onOverwrite: () => (called = 'overwrite'),
      onReload: () => (called = 'reload'),
    });
    document.querySelector('.btn-reload').click();
    expect(called).toBe('reload');
  });

  it('fires onCancel', () => {
    let called = '';
    showConflictDialog({
      fileName: 'note.md',
      diskContent: 'a',
      editorContent: 'b',
      onOverwrite: () => (called = 'overwrite'),
      onReload: () => (called = 'reload'),
      onCancel: () => (called = 'cancel'),
    });
    document.querySelector('.btn-cancel').click();
    expect(called).toBe('cancel');
    expect(document.querySelector('.save-conflict-overlay')).toBeNull();
  });

  it('escapes the file name to avoid HTML injection', () => {
    showConflictDialog({
      fileName: '<img src=x>.md',
      diskContent: 'a',
      editorContent: 'b',
      onOverwrite: () => {},
      onReload: () => {},
    });
    // The name must appear as text, not as an actual <img> element.
    expect(document.querySelector('.save-conflict-overlay img')).toBeNull();
    expect(document.querySelector('.save-conflict-overlay').textContent).toContain(
      '<img src=x>.md',
    );
  });
});
