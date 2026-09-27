// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import body from '../lib/body.js';

const { readBody } = body;

/** A fake request that emits the given chunks, then 'end'. */
function fakeReq(chunks) {
  const req = new EventEmitter();
  req.destroyed = false;
  req.destroy = () => {
    req.destroyed = true;
  };
  queueMicrotask(() => {
    for (const c of chunks) {
      if (req.destroyed) return;
      req.emit('data', c);
    }
    req.emit('end');
  });
  return req;
}

const read = (req, opts) =>
  new Promise((resolve, reject) =>
    readBody(req, opts || {}, (err, text) => (err ? reject(err) : resolve(text))),
  );

/** Split a buffer at every `size` bytes. */
function chunked(buf, size) {
  const out = [];
  for (let i = 0; i < buf.length; i += size) out.push(buf.subarray(i, i + size));
  return out;
}

describe('readBody', () => {
  // The bug: `body += chunk` decoded each chunk separately, so a character
  // split across two chunks became "��".
  it('keeps a multi-byte character that straddles a chunk boundary', async () => {
    const buf = Buffer.from('あ', 'utf8'); // 3 bytes
    const text = await read(fakeReq([buf.subarray(0, 1), buf.subarray(1)]));
    expect(text).toBe('あ');
  });

  it('round-trips Japanese text split at every possible chunk size', async () => {
    const original = JSON.stringify({
      content: '日本語の文章です。絵文字🎉も、改行\nも、「記号」も。'.repeat(50),
    });
    const buf = Buffer.from(original, 'utf8');
    for (const size of [1, 2, 3, 4, 5, 7, 16, 1000]) {
      const text = await read(fakeReq(chunked(buf, size)));
      expect(text).toBe(original);
      expect(text).not.toContain('�');
    }
  });

  it('returns an empty string for an empty body', async () => {
    expect(await read(fakeReq([]))).toBe('');
  });

  it('accepts string chunks too', async () => {
    expect(await read(fakeReq(['{"a":', '1}']))).toBe('{"a":1}');
  });

  it('refuses a body over the byte limit and stops the request', async () => {
    const req = fakeReq([Buffer.alloc(6), Buffer.alloc(6)]);
    await expect(read(req, { limitBytes: 10 })).rejects.toMatchObject({ code: 'BODY_TOO_LARGE' });
    expect(req.destroyed).toBe(true);
  });

  it('counts the limit in bytes, not characters', async () => {
    // 4 characters, 12 bytes.
    const req = fakeReq([Buffer.from('ああああ', 'utf8')]);
    await expect(read(req, { limitBytes: 10 })).rejects.toMatchObject({ code: 'BODY_TOO_LARGE' });
  });

  it('reports a stream error once', async () => {
    const req = new EventEmitter();
    const calls = [];
    readBody(req, {}, (err) => calls.push(err && err.message));
    req.emit('error', new Error('boom'));
    req.emit('end');
    expect(calls).toEqual(['boom']);
  });
});
