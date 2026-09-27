// body.js - read an HTTP request body as UTF-8 text.
//
// The body arrives in chunks whose boundaries fall wherever the network put
// them — for HTTPS, every TLS record (≤16 KB). Decoding each chunk on its own
// (`body += chunk`) splits any multi-byte character that straddles a boundary
// and turns it into U+FFFD. For Japanese text that meant a saved file came
// back with "�" at the same spots on every save, since the same document
// splits the same way. Bytes are therefore collected first and decoded once.

/**
 * Collect a request body and decode it as UTF-8.
 *
 * @param {import('stream').Readable} req
 * @param {{limitBytes?: number}} [opts] bodies above the limit are refused
 *   (the request is destroyed) so a client cannot exhaust memory
 * @param {(err: Error|null, text?: string) => void} done called exactly once
 */
function readBody(req, { limitBytes = 64 * 1024 * 1024 } = {}, done) {
  const chunks = [];
  let size = 0;
  let finished = false;
  const finish = (err, text) => {
    if (finished) return;
    finished = true;
    done(err, text);
  };

  req.on('data', (chunk) => {
    if (finished) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    size += buf.length;
    if (size > limitBytes) {
      const err = new Error('Request body too large');
      err.code = 'BODY_TOO_LARGE';
      finish(err);
      if (typeof req.destroy === 'function') req.destroy();
      return;
    }
    chunks.push(buf);
  });
  req.on('end', () => finish(null, Buffer.concat(chunks, size).toString('utf8')));
  req.on('error', (err) => finish(err));
}

module.exports = { readBody };
