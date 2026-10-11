import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PAST_END_RATIO,
  attachScrollPastEnd,
  isPastEnd,
  isScrollPastEndEnabled,
  naturalMaxScroll,
  onScrollPastEndChange,
  pastEndSpace,
  scrollToDocumentEnd,
  setScrollPastEndEnabled,
} from '../core/scroll-past-end.js';

/** A scroll container with fixed geometry (jsdom lays nothing out). */
function fakeContainer({ clientHeight = 400, scrollHeight = 1000, scrollTop = 0 } = {}) {
  const el = document.createElement('div');
  const size = { clientHeight, scrollHeight };
  Object.defineProperty(el, 'clientHeight', { get: () => size.clientHeight });
  Object.defineProperty(el, 'scrollHeight', { get: () => size.scrollHeight });
  el.scrollTop = scrollTop;
  el._size = size;
  return el;
}

beforeEach(() => setScrollPastEndEnabled(true));
afterEach(() => setScrollPastEndEnabled(true));

describe('pastEndSpace', () => {
  it('is half the pane height', () => {
    expect(PAST_END_RATIO).toBe(0.5);
    expect(pastEndSpace(400)).toBe(200);
  });

  it('rounds down to whole pixels', () => {
    expect(pastEndSpace(401)).toBe(200);
  });

  it('is zero for a pane with no height yet', () => {
    expect(pastEndSpace(0)).toBe(0);
    expect(pastEndSpace(-5)).toBe(0);
    expect(pastEndSpace(NaN)).toBe(0);
    expect(pastEndSpace(undefined)).toBe(0);
  });

  it('is zero when switched off', () => {
    expect(pastEndSpace(400, false)).toBe(0);
    setScrollPastEndEnabled(false);
    expect(pastEndSpace(400)).toBe(0);
  });
});

describe('naturalMaxScroll', () => {
  it('leaves the space out', () => {
    expect(naturalMaxScroll({ scrollHeight: 1200, clientHeight: 400 }, 200)).toBe(600);
  });

  it('is the plain maximum without space', () => {
    expect(naturalMaxScroll({ scrollHeight: 1000, clientHeight: 400 }, 0)).toBe(600);
  });

  it('never goes below zero for a document shorter than the pane', () => {
    expect(naturalMaxScroll({ scrollHeight: 500, clientHeight: 400 }, 200)).toBe(0);
    expect(naturalMaxScroll({ scrollHeight: 400, clientHeight: 400 }, 200)).toBe(0);
  });

  it('ignores a negative space', () => {
    expect(naturalMaxScroll({ scrollHeight: 1000, clientHeight: 400 }, -50)).toBe(600);
  });
});

describe('isPastEnd', () => {
  const m = (scrollTop) => ({ scrollTop, scrollHeight: 1200, clientHeight: 400 });

  it('is false up to the end of the document', () => {
    expect(isPastEnd(m(0), 200)).toBe(false);
    expect(isPastEnd(m(599), 200)).toBe(false);
    expect(isPastEnd(m(600), 200)).toBe(false);
  });

  it('is true once scrolled into the space', () => {
    expect(isPastEnd(m(601), 200)).toBe(true);
    expect(isPastEnd(m(800), 200)).toBe(true);
  });

  it('tolerates a fractional position at the end', () => {
    expect(isPastEnd(m(600.4), 200)).toBe(false);
  });

  it('is never true without space', () => {
    expect(isPastEnd(m(600), 0)).toBe(false);
    expect(isPastEnd({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 }, 0)).toBe(false);
  });

  it('is false for a short document that cannot scroll', () => {
    expect(isPastEnd({ scrollTop: 0, scrollHeight: 400, clientHeight: 400 }, 200)).toBe(false);
  });

  it('is true for a short document lifted off the bottom', () => {
    // 300px of text + 200px of space in a 400px pane: 100px of travel.
    expect(isPastEnd({ scrollTop: 60, scrollHeight: 500, clientHeight: 400 }, 200)).toBe(true);
  });
});

describe('enabling', () => {
  it('starts enabled and reports changes', () => {
    expect(isScrollPastEndEnabled()).toBe(true);
    const seen = [];
    const off = onScrollPastEndChange((on) => seen.push(on));
    setScrollPastEndEnabled(false);
    setScrollPastEndEnabled(true);
    off();
    setScrollPastEndEnabled(false);
    expect(seen).toEqual([false, true]);
  });

  it('does not report a value that did not change', () => {
    const fn = vi.fn();
    const off = onScrollPastEndChange(fn);
    setScrollPastEndEnabled(true);
    setScrollPastEndEnabled(1);
    off();
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('scrollToDocumentEnd', () => {
  it('stops with the last line at the bottom, not in the space', () => {
    const el = fakeContainer({ clientHeight: 400, scrollHeight: 1200 });
    scrollToDocumentEnd(el);
    expect(el.scrollTop).toBe(600);
  });

  it('goes to the very bottom when switched off', () => {
    setScrollPastEndEnabled(false);
    const el = fakeContainer({ clientHeight: 400, scrollHeight: 1000 });
    scrollToDocumentEnd(el);
    expect(el.scrollTop).toBe(600);
  });

  it('stays at the top for a short document', () => {
    const el = fakeContainer({ clientHeight: 400, scrollHeight: 500 });
    scrollToDocumentEnd(el);
    expect(el.scrollTop).toBe(0);
  });
});

describe('attachScrollPastEnd', () => {
  let observers;
  beforeEach(() => {
    observers = [];
    globalThis.ResizeObserver = class {
      constructor(cb) {
        this.cb = cb;
        this.observed = [];
        this.disconnected = false;
        observers.push(this);
      }
      observe(el) {
        this.observed.push(el);
      }
      disconnect() {
        this.disconnected = true;
      }
    };
  });
  afterEach(() => {
    delete globalThis.ResizeObserver;
  });

  it('sets the space from the pane height', () => {
    const el = fakeContainer({ clientHeight: 400 });
    attachScrollPastEnd(el);
    expect(el.style.getPropertyValue('--past-end-space')).toBe('200px');
    expect(el.classList.contains('scroll-past-end')).toBe(true);
    expect(el.classList.contains('is-past-end')).toBe(false);
  });

  it('shows the end rule only while scrolled into the space', () => {
    const el = fakeContainer({ clientHeight: 400, scrollHeight: 1200 });
    attachScrollPastEnd(el);

    el.scrollTop = 600;
    el.dispatchEvent(new Event('scroll'));
    expect(el.classList.contains('is-past-end')).toBe(false);

    el.scrollTop = 700;
    el.dispatchEvent(new Event('scroll'));
    expect(el.classList.contains('is-past-end')).toBe(true);

    el.scrollTop = 100;
    el.dispatchEvent(new Event('scroll'));
    expect(el.classList.contains('is-past-end')).toBe(false);
  });

  it('follows the pane when it is resized', () => {
    const el = fakeContainer({ clientHeight: 400 });
    attachScrollPastEnd(el);
    expect(observers[0].observed).toEqual([el]);

    el._size.clientHeight = 300;
    observers[0].cb();
    expect(el.style.getPropertyValue('--past-end-space')).toBe('150px');
  });

  it('has no space while the pane is hidden, and gains it when shown', () => {
    const el = fakeContainer({ clientHeight: 0 });
    attachScrollPastEnd(el);
    expect(el.style.getPropertyValue('--past-end-space')).toBe('0px');
    expect(el.classList.contains('scroll-past-end')).toBe(false);

    el._size.clientHeight = 500;
    observers[0].cb();
    expect(el.style.getPropertyValue('--past-end-space')).toBe('250px');
    expect(el.classList.contains('scroll-past-end')).toBe(true);
  });

  it('drops the space when switched off and restores it when switched on', () => {
    const el = fakeContainer({ clientHeight: 400, scrollHeight: 1200, scrollTop: 700 });
    attachScrollPastEnd(el);
    expect(el.classList.contains('is-past-end')).toBe(true);

    setScrollPastEndEnabled(false);
    expect(el.style.getPropertyValue('--past-end-space')).toBe('0px');
    expect(el.classList.contains('scroll-past-end')).toBe(false);
    expect(el.classList.contains('is-past-end')).toBe(false);

    setScrollPastEndEnabled(true);
    expect(el.style.getPropertyValue('--past-end-space')).toBe('200px');
    expect(el.classList.contains('scroll-past-end')).toBe(true);
  });

  it('cleans up on detach', () => {
    const el = fakeContainer({ clientHeight: 400, scrollHeight: 1200, scrollTop: 700 });
    const detach = attachScrollPastEnd(el);
    detach();

    expect(el.classList.contains('scroll-past-end')).toBe(false);
    expect(el.classList.contains('is-past-end')).toBe(false);
    expect(el.style.getPropertyValue('--past-end-space')).toBe('');
    expect(observers[0].disconnected).toBe(true);

    // No longer listening to scrolls or to the switch.
    el.dispatchEvent(new Event('scroll'));
    setScrollPastEndEnabled(false);
    expect(el.classList.contains('is-past-end')).toBe(false);
    expect(el.style.getPropertyValue('--past-end-space')).toBe('');
  });

  it('works where ResizeObserver does not exist', () => {
    delete globalThis.ResizeObserver;
    const el = fakeContainer({ clientHeight: 400 });
    const detach = attachScrollPastEnd(el);
    expect(el.style.getPropertyValue('--past-end-space')).toBe('200px');
    expect(() => detach()).not.toThrow();
  });
});
