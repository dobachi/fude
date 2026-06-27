import { describe, it, expect } from 'vitest';
import { tabActionForKey } from '../core/tab-keys.js';

const ev = (over) => ({
  key: 'Tab',
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
});

describe('tabActionForKey', () => {
  it('Ctrl+Tab → next', () => {
    expect(tabActionForKey(ev({ key: 'Tab', ctrlKey: true }))).toBe('next');
  });

  it('Ctrl+Shift+Tab → prev', () => {
    expect(tabActionForKey(ev({ key: 'Tab', ctrlKey: true, shiftKey: true }))).toBe('prev');
  });

  it('Cmd+Tab (metaKey) → next on macOS', () => {
    expect(tabActionForKey(ev({ key: 'Tab', metaKey: true }))).toBe('next');
  });

  it('Ctrl+PageDown → next (focus-neutral alias)', () => {
    expect(tabActionForKey(ev({ key: 'PageDown', ctrlKey: true }))).toBe('next');
  });

  it('Ctrl+PageUp → prev (works on WebKitGTK where Ctrl+Shift+Tab is swallowed)', () => {
    expect(tabActionForKey(ev({ key: 'PageUp', ctrlKey: true }))).toBe('prev');
  });

  it('PageUp/PageDown ignore Shift', () => {
    expect(tabActionForKey(ev({ key: 'PageUp', ctrlKey: true, shiftKey: true }))).toBe('prev');
    expect(tabActionForKey(ev({ key: 'PageDown', ctrlKey: true, shiftKey: true }))).toBe('next');
  });

  it('requires a modifier', () => {
    expect(tabActionForKey(ev({ key: 'Tab' }))).toBeNull();
    expect(tabActionForKey(ev({ key: 'PageUp' }))).toBeNull();
    expect(tabActionForKey(ev({ key: 'PageDown' }))).toBeNull();
  });

  it('Alt disqualifies (Ctrl+Alt+* is not tab switching)', () => {
    expect(tabActionForKey(ev({ key: 'Tab', ctrlKey: true, altKey: true }))).toBeNull();
    expect(tabActionForKey(ev({ key: 'PageDown', ctrlKey: true, altKey: true }))).toBeNull();
  });

  it('unrelated keys → null', () => {
    expect(tabActionForKey(ev({ key: 'a', ctrlKey: true }))).toBeNull();
    expect(tabActionForKey(ev({ key: 'ArrowLeft', ctrlKey: true }))).toBeNull();
  });
});
