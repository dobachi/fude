import { describe, it, expect } from 'vitest';
import {
  AI_ACTION_IDS,
  buildEditorMenuItems,
  buildPreviewMenuItems,
} from '../core/editor-menu-items.js';

const ids = (items) => items.filter((i) => !i.separator).map((i) => i.id);
const byId = (items, id) => items.find((i) => i.id === id);

describe('buildEditorMenuItems', () => {
  it('shows edit items even without a selection (no browser fallback)', () => {
    const items = buildEditorMenuItems({ hasSelection: false });
    expect(ids(items)).toEqual([
      'undo',
      'redo',
      'cut',
      'copy',
      'paste',
      'delete',
      'select-all',
      'to-table',
    ]);
  });

  it('disables selection-dependent items without a selection', () => {
    const items = buildEditorMenuItems({ hasSelection: false });
    for (const id of ['cut', 'copy', 'delete', 'to-table']) {
      expect(byId(items, id).disabled).toBe(true);
    }
    expect(byId(items, 'paste').disabled).toBeFalsy();
    expect(byId(items, 'select-all').disabled).toBeFalsy();
  });

  it('hides AI items without a selection and shows them with one', () => {
    expect(ids(buildEditorMenuItems({ hasSelection: false }))).not.toContain('ask-ai');
    const withSel = ids(buildEditorMenuItems({ hasSelection: true }));
    expect(withSel).toContain('ask-ai');
    for (const id of AI_ACTION_IDS) expect(withSel).toContain(id);
  });

  it('enables selection-dependent items with a selection', () => {
    const items = buildEditorMenuItems({ hasSelection: true });
    for (const id of ['cut', 'copy', 'delete', 'to-table']) {
      expect(byId(items, id).disabled).toBe(false);
    }
  });

  it('reflects undo/redo availability', () => {
    const items = buildEditorMenuItems({ hasSelection: false, canUndo: false, canRedo: true });
    expect(byId(items, 'undo').disabled).toBe(true);
    expect(byId(items, 'redo').disabled).toBe(false);
  });

  it('uses Japanese labels with shortcut hints like the menu bar', () => {
    const items = buildEditorMenuItems({ hasSelection: true });
    expect(byId(items, 'copy')).toMatchObject({ label: 'コピー', shortcut: 'Ctrl+C' });
    expect(byId(items, 'paste')).toMatchObject({ label: '貼り付け', shortcut: 'Ctrl+V' });
  });

  it('never starts, ends, or doubles up with separators', () => {
    for (const hasSelection of [true, false]) {
      const items = buildEditorMenuItems({ hasSelection });
      expect(items[0].separator).toBeFalsy();
      expect(items[items.length - 1].separator).toBeFalsy();
      for (let i = 1; i < items.length; i++) {
        expect(items[i].separator && items[i - 1].separator).toBeFalsy();
      }
    }
  });
});

describe('buildPreviewMenuItems', () => {
  it('offers copy, disabled without a selection', () => {
    expect(buildPreviewMenuItems({ hasSelection: false })).toEqual([
      { id: 'copy', label: 'コピー', shortcut: 'Ctrl+C', disabled: true },
    ]);
    expect(byId(buildPreviewMenuItems({ hasSelection: true }), 'copy').disabled).toBe(false);
  });
});
