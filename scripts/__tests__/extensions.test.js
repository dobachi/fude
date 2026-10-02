// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import extensions from '../lib/extensions.js';

const { isSafeComponent, isSafeRel, status, filePath, readFile, uninstall, findEntry, install } =
  extensions;

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fude-ext-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Lay out an installed extension the way the desktop app does. */
function seedInstalled(id, version, files) {
  const dir = path.join(root, id, version);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  fs.writeFileSync(path.join(dir, '.complete'), version);
  return dir;
}

/** A fetch stand-in serving a manifest and files from a map. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    if (!(url in routes)) return { ok: false, status: 404, text: async () => '', body: [] };
    const v = routes[url];
    const buf = Buffer.from(v);
    // Two chunks, so progress is reported more than once per file.
    const half = Math.ceil(buf.length / 2);
    return {
      ok: true,
      status: 200,
      text: async () => String(v),
      body: [buf.subarray(0, half), buf.subarray(half)],
    };
  };
  impl.calls = calls;
  return impl;
}

const MANIFEST_URL = 'https://example.test/manifest.json';

function manifestFor(entries) {
  return JSON.stringify({ schema: 1, extensions: entries });
}

describe('isSafeComponent / isSafeRel', () => {
  it('accepts plain ids and versions', () => {
    expect(isSafeComponent('plantuml')).toBe(true);
    expect(isSafeComponent('1.2026.6beta1')).toBe(true);
  });

  it('rejects anything that could leave the directory', () => {
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'C:', 'a\0b', undefined, null, 3]) {
      expect(isSafeComponent(bad)).toBe(false);
    }
  });

  it('accepts nested relative files but not traversal or absolute paths', () => {
    expect(isSafeRel('plantuml.js')).toBe(true);
    expect(isSafeRel('themes/shared_style.puml')).toBe(true);
    for (const bad of ['', '../x', 'a/../../x', '/etc/passwd', 'a\\b', 'a//b', './a', 'C:x']) {
      expect(isSafeRel(bad)).toBe(false);
    }
  });
});

describe('status / readFile / filePath / uninstall', () => {
  it('reports an extension that is not installed', () => {
    expect(status(root, 'mermaid')).toEqual({ installed: false, version: null, dir: null });
  });

  it('ignores a version directory without the .complete marker', () => {
    fs.mkdirSync(path.join(root, 'mermaid', '1.0.0'), { recursive: true });
    expect(status(root, 'mermaid').installed).toBe(false);
  });

  it('finds an installed extension and reads its files', () => {
    const dir = seedInstalled('plantuml-archimate', '3.2.1', {
      'Archimate.puml': 'A',
      'themes/shared_style.puml': 'S',
    });
    expect(status(root, 'plantuml-archimate')).toEqual({
      installed: true,
      version: '3.2.1',
      dir,
    });
    expect(readFile(root, 'plantuml-archimate', 'themes/shared_style.puml')).toBe('S');
    expect(filePath(root, 'plantuml-archimate', 'Archimate.puml')).toBe(
      path.join(dir, 'Archimate.puml'),
    );
  });

  it('refuses to read outside the extension directory', () => {
    seedInstalled('mermaid', '1.0.0', { 'mermaid.min.js': 'm' });
    fs.writeFileSync(path.join(root, 'secret.txt'), 'TOP SECRET');
    expect(() => readFile(root, 'mermaid', '../../secret.txt')).toThrow('Invalid extension path');
    expect(() => readFile(root, '..', 'secret.txt')).toThrow('Invalid extension path');
    expect(() => status(root, '../x')).toThrow('Invalid extension id');
  });

  it('errors on a missing file or an uninstalled extension', () => {
    seedInstalled('mermaid', '1.0.0', { 'mermaid.min.js': 'm' });
    expect(() => readFile(root, 'mermaid', 'nope.js')).toThrow();
    expect(() => readFile(root, 'plantuml', 'plantuml.js')).toThrow('not installed');
  });

  it('uninstalls, and uninstalling again is a no-op', () => {
    seedInstalled('mermaid', '1.0.0', { 'mermaid.min.js': 'm' });
    uninstall(root, 'mermaid');
    expect(status(root, 'mermaid').installed).toBe(false);
    expect(() => uninstall(root, 'mermaid')).not.toThrow();
    expect(() => uninstall(root, '..')).toThrow('Invalid extension id');
  });
});

describe('findEntry', () => {
  const file = { rel: 'a.js', url: 'https://x.test/a.js', sha256: sha('a') };

  it('returns the requested entry', () => {
    const m = manifestFor([{ id: 'a', version: '1', files: [file] }]);
    expect(findEntry(m, 'a').version).toBe('1');
  });

  it('rejects a bad manifest', () => {
    expect(() => findEntry('not json', 'a')).toThrow('Invalid manifest JSON');
    expect(() => findEntry(manifestFor([]), 'a')).toThrow('not found in manifest');
  });

  it('rejects unsafe versions, paths, URLs and missing checksums', () => {
    const bad = (entry) => () => findEntry(manifestFor([{ id: 'a', ...entry }]), 'a');
    expect(bad({ version: '..', files: [file] })).toThrow('Invalid extension version');
    expect(bad({ version: '1', files: [{ ...file, rel: '../x' }] })).toThrow('Invalid file path');
    expect(bad({ version: '1', files: [{ ...file, url: 'http://x.test/a' }] })).toThrow(
      'Invalid download URL',
    );
    expect(bad({ version: '1', files: [{ ...file, sha256: '' }] })).toThrow('Missing sha256');
  });
});

describe('install', () => {
  function setup({ version = '2.0.0', files, overrides = {} } = {}) {
    const list = files || [
      { rel: 'engine.js', content: 'ENGINE' },
      { rel: 'lib/extra.js', content: 'EXTRA' },
    ];
    const routes = {};
    const entryFiles = list.map((f) => {
      const url = `https://x.test/${f.rel}`;
      routes[url] = f.content;
      return { rel: f.rel, url, sha256: f.sha ?? sha(f.content), size: f.content.length };
    });
    routes[MANIFEST_URL] = manifestFor([{ id: 'eng', version, files: entryFiles }]);
    Object.assign(routes, overrides);
    return fakeFetch(routes);
  }

  it('downloads, verifies and installs, reporting progress up to the total', async () => {
    const fetchImpl = setup();
    const progress = [];
    const result = await install({
      root,
      id: 'eng',
      fetchImpl,
      manifestUrl: MANIFEST_URL,
      onProgress: (p, t) => progress.push([p, t]),
    });
    expect(result).toEqual({ version: '2.0.0', total: 11 });
    expect(readFile(root, 'eng', 'engine.js')).toBe('ENGINE');
    expect(readFile(root, 'eng', 'lib/extra.js')).toBe('EXTRA');
    expect(progress.length).toBeGreaterThan(2);
    expect(progress.at(-1)).toEqual([11, 11]);
    expect(fs.existsSync(path.join(root, 'eng', '2.0.0.tmp'))).toBe(false);
  });

  it('replaces an older version', async () => {
    seedInstalled('eng', '1.0.0', { 'engine.js': 'OLD' });
    await install({ root, id: 'eng', fetchImpl: setup(), manifestUrl: MANIFEST_URL });
    expect(fs.readdirSync(path.join(root, 'eng'))).toEqual(['2.0.0']);
    expect(readFile(root, 'eng', 'engine.js')).toBe('ENGINE');
  });

  it('leaves nothing behind when a checksum does not match', async () => {
    const fetchImpl = setup({ files: [{ rel: 'engine.js', content: 'ENGINE', sha: sha('x') }] });
    await expect(
      install({ root, id: 'eng', fetchImpl, manifestUrl: MANIFEST_URL }),
    ).rejects.toThrow('Checksum mismatch');
    expect(status(root, 'eng').installed).toBe(false);
    expect(fs.readdirSync(path.join(root, 'eng'))).toEqual([]);
  });

  it('keeps the previous install when a download fails', async () => {
    seedInstalled('eng', '1.0.0', { 'engine.js': 'OLD' });
    const ok = setup();
    const routesFetch = async (url, opts) => {
      if (url.endsWith('extra.js')) return { ok: false, status: 500, body: [] };
      return ok(url, opts);
    };
    await expect(
      install({ root, id: 'eng', fetchImpl: routesFetch, manifestUrl: MANIFEST_URL }),
    ).rejects.toThrow('HTTP 500');
    expect(readFile(root, 'eng', 'engine.js')).toBe('OLD');
  });

  it('reports a manifest that cannot be fetched', async () => {
    await expect(
      install({ root, id: 'eng', fetchImpl: fakeFetch({}), manifestUrl: MANIFEST_URL }),
    ).rejects.toThrow('Manifest request failed: HTTP 404');
  });

  it('rejects an unsafe id before touching the network', async () => {
    const fetchImpl = fakeFetch({});
    await expect(install({ root, id: '../x', fetchImpl })).rejects.toThrow('Invalid extension id');
    expect(fetchImpl.calls).toEqual([]);
  });
});
