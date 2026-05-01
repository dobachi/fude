import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { computeBulletToggle, computeNumberedToggle } from '../core/editor.js';

function stateWith(doc, from = 0, to = from) {
  return EditorState.create({ doc, selection: { anchor: from, head: to } });
}

function applyChanges(state, tr) {
  if (!tr) return state.doc.toString();
  return state.update(tr).newDoc.toString();
}

describe('computeBulletToggle', () => {
  it('adds "- " to a plain line', () => {
    const state = stateWith('hello');
    expect(applyChanges(state, computeBulletToggle(state))).toBe('- hello');
  });

  it('removes "- " from a bulleted line', () => {
    const state = stateWith('- hello');
    expect(applyChanges(state, computeBulletToggle(state))).toBe('hello');
  });

  it('removes existing "* " bullet markers when toggling off', () => {
    const state = stateWith('* a\n* b', 0, 7);
    expect(applyChanges(state, computeBulletToggle(state))).toBe('a\nb');
  });

  it('adds "- " to all selected plain lines', () => {
    const state = stateWith('a\nb\nc', 0, 5);
    expect(applyChanges(state, computeBulletToggle(state))).toBe('- a\n- b\n- c');
  });

  it('mixed selection adds "- " to non-bulleted lines only', () => {
    const state = stateWith('- a\nb', 0, 5);
    expect(applyChanges(state, computeBulletToggle(state))).toBe('- a\n- b');
  });

  it('preserves indentation', () => {
    const state = stateWith('  hello');
    expect(applyChanges(state, computeBulletToggle(state))).toBe('  - hello');
  });

  it('skips empty lines', () => {
    const state = stateWith('a\n\nb', 0, 4);
    expect(applyChanges(state, computeBulletToggle(state))).toBe('- a\n\n- b');
  });

  it('converts numbered list to bullet list', () => {
    const state = stateWith('1. a\n2. b', 0, 9);
    expect(applyChanges(state, computeBulletToggle(state))).toBe('- a\n- b');
  });

  it('returns null for empty selection on empty line', () => {
    const state = stateWith('');
    expect(computeBulletToggle(state)).toBeNull();
  });
});

describe('computeNumberedToggle', () => {
  it('adds "1. " to a plain line', () => {
    const state = stateWith('hello');
    expect(applyChanges(state, computeNumberedToggle(state))).toBe('1. hello');
  });

  it('removes numbered markers from a numbered line', () => {
    const state = stateWith('1. hello');
    expect(applyChanges(state, computeNumberedToggle(state))).toBe('hello');
  });

  it('numbers selected plain lines sequentially', () => {
    const state = stateWith('a\nb\nc', 0, 5);
    expect(applyChanges(state, computeNumberedToggle(state))).toBe('1. a\n2. b\n3. c');
  });

  it('removes all numbers when toggling off a numbered list', () => {
    const state = stateWith('1. a\n2. b\n3. c', 0, 14);
    expect(applyChanges(state, computeNumberedToggle(state))).toBe('a\nb\nc');
  });

  it('renumbers existing numbers when adding to a mixed selection', () => {
    const state = stateWith('5. a\nb', 0, 6);
    expect(applyChanges(state, computeNumberedToggle(state))).toBe('1. a\n2. b');
  });

  it('converts bullet list to numbered list', () => {
    const state = stateWith('- a\n- b', 0, 7);
    expect(applyChanges(state, computeNumberedToggle(state))).toBe('1. a\n2. b');
  });

  it('handles multi-digit existing numbers when stripping', () => {
    const state = stateWith('10. a\n11. b', 0, 11);
    expect(applyChanges(state, computeNumberedToggle(state))).toBe('a\nb');
  });

  it('preserves indentation', () => {
    const state = stateWith('  a\n  b', 0, 7);
    expect(applyChanges(state, computeNumberedToggle(state))).toBe('  1. a\n  2. b');
  });
});
