import { describe, it, expect, beforeEach } from 'vitest';
import {
  clampUiFontSize,
  setUiFontSize,
  getUiFontSize,
  UI_FONT_MIN,
  UI_FONT_MAX,
  UI_FONT_DEFAULT,
} from '../core/ui-font.js';

describe('clampUiFontSize', () => {
  it('keeps values within bounds unchanged', () => {
    expect(clampUiFontSize(14)).toBe(14);
    expect(clampUiFontSize(UI_FONT_MIN)).toBe(UI_FONT_MIN);
    expect(clampUiFontSize(UI_FONT_MAX)).toBe(UI_FONT_MAX);
  });

  it('clamps below min and above max', () => {
    expect(clampUiFontSize(UI_FONT_MIN - 5)).toBe(UI_FONT_MIN);
    expect(clampUiFontSize(UI_FONT_MAX + 99)).toBe(UI_FONT_MAX);
  });

  it('rounds fractional values', () => {
    expect(clampUiFontSize(14.6)).toBe(15);
    expect(clampUiFontSize(13.2)).toBe(13);
  });

  it('falls back to default on non-numeric input', () => {
    expect(clampUiFontSize(NaN)).toBe(UI_FONT_DEFAULT);
    expect(clampUiFontSize(undefined)).toBe(UI_FONT_DEFAULT);
    expect(clampUiFontSize('abc')).toBe(UI_FONT_DEFAULT);
  });

  it('parses numeric strings', () => {
    expect(clampUiFontSize('18')).toBe(18);
  });
});

describe('setUiFontSize / getUiFontSize', () => {
  beforeEach(() => {
    document.documentElement.style.removeProperty('--ui-font-size');
    setUiFontSize(UI_FONT_DEFAULT);
  });

  it('applies the CSS custom property on the document root', () => {
    setUiFontSize(20);
    expect(document.documentElement.style.getPropertyValue('--ui-font-size')).toBe('20px');
    expect(getUiFontSize()).toBe(20);
  });

  it('returns and stores the clamped value', () => {
    expect(setUiFontSize(999)).toBe(UI_FONT_MAX);
    expect(getUiFontSize()).toBe(UI_FONT_MAX);
    expect(document.documentElement.style.getPropertyValue('--ui-font-size')).toBe(
      `${UI_FONT_MAX}px`,
    );
  });
});
