// extensions.js - downloadable extensions (PlantUML / Mermaid engines, stdlib
// packs) for browser mode.
//
// Browser mode's counterpart of the desktop commands of the same names
// (src-tauri/src/lib.rs: fetch_extension_manifest, extension_status,
// extension_file_path, read_extension_file, install_extension,
// uninstall_extension). Same catalogue URL, same on-disk layout
// (`<root>/<id>/<version>/` holding a `.complete` marker), so an engine
// installed by the desktop app on the same machine is picked up here and
// vice versa.
//
// Stricter than the desktop version, because here the request comes over the
// network: a file's sha256 is mandatory, and every path is checked to stay
// inside the extension's directory after resolution.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MANIFEST_URL = 'https://raw.githubusercontent.com/dobachi/fude-extensions/main/manifest.json';

/**
 * Whether `s` is usable as a single path component (an id or a version):
 * non-empty, not `.`/`..`, and free of separators and drive colons.
 * @param {unknown} s
 * @returns {boolean}
 */
function isSafeComponent(s) {
  return (
    typeof s === 'string' &&
    s !== '' &&
    s !== '.' &&
    s !== '..' &&
    !s.includes('/') &&
    !s.includes('\\') &&
    !s.includes(':') &&
    !s.includes('\0')
  );
}

/**
 * Whether `rel` is a safe relative file path inside an extension directory
 * (e.g. "plantuml.js" or "stdlib/archimate/Archimate.puml").
 * @param {unknown} rel
 * @returns {boolean}
 */
function isSafeRel(rel) {
  if (typeof rel !== 'string' || rel === '') return false;
  if (rel.includes('\\') || rel.includes('\0') || rel.includes(':')) return false;
  if (rel.startsWith('/')) return false;
  return rel.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/**
 * The directory holding the installed version of `id`, or null.
 * @param {string} root the extensions root (`<config>/extensions`)
 * @param {string} id
 * @returns {{version: string, dir: string} | null}
 */
function findInstalled(root, id) {
  if (!isSafeComponent(id)) return null;
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, id), { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, id, e.name);
    if (fs.existsSync(path.join(dir, '.complete'))) return { version: e.name, dir };
  }
  return null;
}

/**
 * `{installed, version, dir}` in the shape the desktop command returns.
 * @param {string} root
 * @param {string} id
 */
function status(root, id) {
  if (!isSafeComponent(id)) throw new Error(`Invalid extension id '${id}'`);
  const found = findInstalled(root, id);
  return found
    ? { installed: true, version: found.version, dir: found.dir }
    : { installed: false, version: null, dir: null };
}

/**
 * Absolute path of an installed extension file.
 * @param {string} root
 * @param {string} id
 * @param {string} rel
 * @returns {string}
 */
function filePath(root, id, rel) {
  if (!isSafeComponent(id) || !isSafeRel(rel)) throw new Error('Invalid extension path');
  const found = findInstalled(root, id);
  if (!found) throw new Error(`Extension '${id}' not installed`);
  const p = path.resolve(found.dir, rel);
  if (!p.startsWith(found.dir + path.sep)) throw new Error('Invalid extension path');
  if (!fs.existsSync(p)) throw new Error(`Extension file '${rel}' not found`);
  return p;
}

/**
 * Text contents of an installed extension file.
 * @param {string} root
 * @param {string} id
 * @param {string} rel
 * @returns {string}
 */
function readFile(root, id, rel) {
  return fs.readFileSync(filePath(root, id, rel), 'utf-8');
}

/**
 * Remove an installed extension entirely (no-op when absent).
 * @param {string} root
 * @param {string} id
 */
function uninstall(root, id) {
  if (!isSafeComponent(id)) throw new Error(`Invalid extension id '${id}'`);
  fs.rmSync(path.join(root, id), { recursive: true, force: true });
  return null;
}

/**
 * Parse the catalogue and return the entry for `id`, validated.
 * @param {string} manifestText
 * @param {string} id
 */
function findEntry(manifestText, id) {
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (e) {
    throw new Error(`Invalid manifest JSON: ${e.message}`);
  }
  const list = Array.isArray(manifest?.extensions) ? manifest.extensions : [];
  const entry = list.find((e) => e && e.id === id);
  if (!entry) throw new Error(`Extension '${id}' not found in manifest`);
  if (!isSafeComponent(entry.version)) {
    throw new Error(`Invalid extension version '${entry.version}'`);
  }
  if (!Array.isArray(entry.files)) throw new Error(`Extension '${id}' has no files`);
  for (const f of entry.files) {
    if (!f || !isSafeRel(f.rel)) throw new Error(`Invalid file path '${f && f.rel}'`);
    if (typeof f.url !== 'string' || !/^https:\/\//.test(f.url)) {
      throw new Error(`Invalid download URL for '${f.rel}'`);
    }
    if (typeof f.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(f.sha256)) {
      throw new Error(`Missing sha256 for '${f.rel}'`);
    }
  }
  return entry;
}

/** Total download size as the desktop computes it. */
function totalSize(entry) {
  if (entry.total_size > 0) return entry.total_size;
  return entry.files.reduce((sum, f) => sum + (Number(f.size) || 0), 0);
}

/**
 * Download, verify and install `id`. Files go into `<id>/<version>.tmp`, are
 * sha256-checked, and only then promoted to `<id>/<version>` with a `.complete`
 * marker; older versions are removed. Any failure leaves no partial install.
 *
 * @param {object} opts
 * @param {string} opts.root extensions root
 * @param {string} opts.id
 * @param {typeof fetch} opts.fetchImpl
 * @param {string} [opts.manifestUrl]
 * @param {(progress: number, total: number) => void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 */
async function install({ root, id, fetchImpl, manifestUrl = MANIFEST_URL, onProgress, signal }) {
  if (!isSafeComponent(id)) throw new Error(`Invalid extension id '${id}'`);
  const entry = findEntry(await fetchManifest(fetchImpl, manifestUrl, signal), id);
  const total = totalSize(entry);

  const idDir = path.join(root, id);
  fs.mkdirSync(idDir, { recursive: true });
  const tmpDir = path.join(idDir, `${entry.version}.tmp`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    let downloaded = 0;
    for (const file of entry.files) {
      const res = await fetchImpl(file.url, { signal });
      if (!res.ok) throw new Error(`Download failed for '${file.rel}': HTTP ${res.status}`);
      const chunks = [];
      for await (const chunk of res.body) {
        const buf = Buffer.from(chunk);
        chunks.push(buf);
        downloaded += buf.length;
        if (onProgress) onProgress(downloaded, total);
      }
      const bytes = Buffer.concat(chunks);
      const actual = crypto.createHash('sha256').update(bytes).digest('hex');
      if (actual !== file.sha256.toLowerCase()) {
        throw new Error(
          `Checksum mismatch for '${file.rel}': expected ${file.sha256}, got ${actual}`,
        );
      }
      const dest = path.join(tmpDir, file.rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, bytes);
    }

    const finalDir = path.join(idDir, entry.version);
    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(tmpDir, finalDir);
    fs.writeFileSync(path.join(finalDir, '.complete'), entry.version);

    for (const e of fs.readdirSync(idDir, { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== entry.version) {
        fs.rmSync(path.join(idDir, e.name), { recursive: true, force: true });
      }
    }
    return { version: entry.version, total };
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * The catalogue JSON as raw text.
 * @param {typeof fetch} fetchImpl
 * @param {string} [manifestUrl]
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
 */
async function fetchManifest(fetchImpl, manifestUrl = MANIFEST_URL, signal) {
  let res;
  try {
    res = await fetchImpl(manifestUrl, { signal });
  } catch (e) {
    throw new Error(`Failed to fetch extension manifest: ${e.message}`);
  }
  if (!res.ok) throw new Error(`Manifest request failed: HTTP ${res.status}`);
  return res.text();
}

module.exports = {
  MANIFEST_URL,
  isSafeComponent,
  isSafeRel,
  findInstalled,
  status,
  filePath,
  readFile,
  uninstall,
  findEntry,
  install,
  fetchManifest,
};
