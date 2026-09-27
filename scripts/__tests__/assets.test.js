// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assets from '../lib/assets.js';

const { normalizeImageExt, saveImageBytes, imageBytesFromArgs } = assets;

describe('normalizeImageExt', () => {
  it('accepts image extensions in any case, with or without a dot', () => {
    expect(normalizeImageExt('png')).toBe('png');
    expect(normalizeImageExt('.JPG')).toBe('jpg');
    expect(normalizeImageExt(' webp ')).toBe('webp');
  });

  it('defaults an empty extension to png, like the desktop', () => {
    expect(normalizeImageExt('')).toBe('png');
    expect(normalizeImageExt(undefined)).toBe('png');
    expect(normalizeImageExt(null)).toBe('png');
  });

  it('refuses anything that is not a plain image extension', () => {
    for (const bad of ['../../x', 'png/../../etc', 'exe', 'html', 'png\u0000', 'p ng']) {
      expect(normalizeImageExt(bad)).toBeNull();
    }
  });
});

describe('imageBytesFromArgs', () => {
  it('reads base64 or a byte array', () => {
    expect(imageBytesFromArgs({ base64: Buffer.from([1, 2, 255]).toString('base64') })).toEqual(
      Buffer.from([1, 2, 255]),
    );
    expect(imageBytesFromArgs({ bytes: [1, 2, 255] })).toEqual(Buffer.from([1, 2, 255]));
    expect(imageBytesFromArgs({})).toBeNull();
    expect(imageBytesFromArgs(null)).toBeNull();
  });
});

describe('saveImageBytes', () => {
  let dir;
  let doc;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fude-assets-'));
    doc = path.join(dir, 'note.md');
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('writes into assets/ beside the document and returns the relative path', () => {
    const rel = saveImageBytes({ docPath: doc, bytes: Buffer.from('BYTES'), ext: 'png' });
    expect(rel).toBe('assets/pasted-image.png');
    expect(fs.readFileSync(path.join(dir, 'assets/pasted-image.png'), 'utf8')).toBe('BYTES');
  });

  it('numbers later pastes instead of overwriting', () => {
    const a = saveImageBytes({ docPath: doc, bytes: Buffer.from('A'), ext: 'png' });
    const b = saveImageBytes({ docPath: doc, bytes: Buffer.from('B'), ext: 'png' });
    const c = saveImageBytes({ docPath: doc, bytes: Buffer.from('C'), ext: 'png' });
    expect([a, b, c]).toEqual([
      'assets/pasted-image.png',
      'assets/pasted-image-1.png',
      'assets/pasted-image-2.png',
    ]);
    expect(fs.readFileSync(path.join(dir, a), 'utf8')).toBe('A');
  });

  it('keeps extensions apart', () => {
    saveImageBytes({ docPath: doc, bytes: Buffer.from('A'), ext: 'png' });
    expect(saveImageBytes({ docPath: doc, bytes: Buffer.from('B'), ext: 'jpg' })).toBe(
      'assets/pasted-image.jpg',
    );
  });

  it('refuses a bad extension without writing anything', () => {
    expect(() => saveImageBytes({ docPath: doc, bytes: Buffer.from('A'), ext: '../x' })).toThrow(
      /Not an image/,
    );
    expect(fs.existsSync(path.join(dir, 'assets'))).toBe(false);
  });

  it('requires a document path and bytes', () => {
    expect(() => saveImageBytes({ docPath: '', bytes: Buffer.from('A') })).toThrow();
    expect(() => saveImageBytes({ docPath: doc, bytes: null })).toThrow();
  });

  it('gives up after maxTries when every name is taken', () => {
    saveImageBytes({ docPath: doc, bytes: Buffer.from('A') });
    saveImageBytes({ docPath: doc, bytes: Buffer.from('B') });
    expect(() => saveImageBytes({ docPath: doc, bytes: Buffer.from('C') }, { maxTries: 2 })).toThrow(
      /free file name/,
    );
  });
});
