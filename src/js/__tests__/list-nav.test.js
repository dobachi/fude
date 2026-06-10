import { describe, it, expect, vi } from 'vitest';
import {
  nextNavIndex,
  isItemVisible,
  getNavItems,
  createListKeyHandler,
} from '../core/list-nav.js';

describe('nextNavIndex', () => {
  it('moves down and clamps at the last item', () => {
    expect(nextNavIndex('ArrowDown', 0, 3)).toBe(1);
    expect(nextNavIndex('ArrowDown', 2, 3)).toBe(2);
  });

  it('moves up and clamps at the first item', () => {
    expect(nextNavIndex('ArrowUp', 2, 3)).toBe(1);
    expect(nextNavIndex('ArrowUp', 0, 3)).toBe(0);
  });

  it('enters the list from "no selection" (-1) at the right end', () => {
    expect(nextNavIndex('ArrowDown', -1, 3)).toBe(0);
    expect(nextNavIndex('ArrowUp', -1, 3)).toBe(2);
  });

  it('Home/End jump to the ends', () => {
    expect(nextNavIndex('Home', 2, 3)).toBe(0);
    expect(nextNavIndex('End', 0, 3)).toBe(2);
  });

  it('returns -1 for non-navigation keys or empty lists', () => {
    expect(nextNavIndex('Enter', 0, 3)).toBe(-1);
    expect(nextNavIndex('a', 0, 3)).toBe(-1);
    expect(nextNavIndex('ArrowDown', 0, 0)).toBe(-1);
  });
});

describe('isItemVisible (tree collapse awareness)', () => {
  it('treats items under a collapsed directory as hidden', () => {
    document.body.innerHTML = `
      <div class="tree-dir">
        <div class="tree-item-label" id="dir"></div>
        <div class="tree-children">
          <div class="tree-item" ><div class="tree-item-label" id="child"></div></div>
        </div>
      </div>`;
    expect(isItemVisible(document.getElementById('child'))).toBe(false);

    document.querySelector('.tree-dir').classList.add('open');
    expect(isItemVisible(document.getElementById('child'))).toBe(true);
  });

  it('treats flat list items (no tree-children) as visible', () => {
    document.body.innerHTML = '<div class="outline-item" id="h"></div>';
    expect(isItemVisible(document.getElementById('h'))).toBe(true);
  });
});

describe('getNavItems', () => {
  it('returns only visible items in document order', () => {
    document.body.innerHTML = `
      <div id="root">
        <div class="x" id="a"></div>
        <div class="tree-dir">
          <div class="x" id="b"></div>
          <div class="tree-children"><div class="x" id="c"></div></div>
        </div>
      </div>`;
    const root = document.getElementById('root');
    const ids = getNavItems(root, '.x').map((el) => el.id);
    expect(ids).toEqual(['a', 'b']); // c hidden under collapsed dir
  });

  it('returns [] for a null container', () => {
    expect(getNavItems(null, '.x')).toEqual([]);
  });
});

describe('createListKeyHandler', () => {
  function setup() {
    document.body.innerHTML = `
      <div id="list">
        <div class="item" id="i0" tabindex="-1"></div>
        <div class="item" id="i1" tabindex="-1"></div>
        <div class="item" id="i2" tabindex="-1"></div>
      </div>`;
    return document.getElementById('list');
  }

  it('Arrow keys move focus among items', () => {
    const list = setup();
    const handler = createListKeyHandler(list, '.item');
    document.getElementById('i0').focus();

    handler(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(document.activeElement.id).toBe('i1');

    handler(new KeyboardEvent('keydown', { key: 'End' }));
    expect(document.activeElement.id).toBe('i2');
  });

  it('Enter activates (clicks) the focused item', () => {
    const list = setup();
    const onClick = vi.fn();
    document.getElementById('i1').addEventListener('click', onClick);
    const handler = createListKeyHandler(list, '.item');
    document.getElementById('i1').focus();

    handler(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(onClick).toHaveBeenCalled();
  });

  it('lets the extra hook handle list-specific keys first', () => {
    const list = setup();
    const extra = vi.fn(() => true); // claims to handle everything
    const handler = createListKeyHandler(list, '.item', { extra });
    document.getElementById('i0').focus();

    handler(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(extra).toHaveBeenCalled();
    expect(document.activeElement.id).toBe('i0'); // generic nav skipped
  });
});
