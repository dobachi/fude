// includes.js - Resolve PlantUML `!include` directives locally (no network),
// so diagrams that use stdlib packs (e.g. `!include <archimate/Archimate>`) or
// local relative files render with the offline TeaVM engine.
//
// - `!include <ns/path>`  -> resolved from the installed stdlib extension whose
//   namespace is `ns` (e.g. archimate -> the `plantuml-archimate` extension).
// - `!include path` / `"path"` (relative or absolute) -> read from disk,
//   resolved against the including file's directory.
// - URL includes (`!includeurl`, `!include http...`) are intentionally NOT
//   fetched (keeps rendering fully local); they are left as-is.
import { readExtensionFile, readFile } from '../../backend.js';

// stdlib namespace -> extension id that provides its files.
const NS_TO_EXT = { archimate: 'plantuml-archimate' };

const MAX_DEPTH = 40;

function dirOf(p) {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(0, i) : '';
}

function ensurePuml(p) {
  return /\.\w+$/.test(p) ? p : `${p}.puml`;
}

// Join + normalize a POSIX-ish path (handles . and ..), preserving a leading
// '/' so absolute base directories aren't turned into relative ones.
function joinNorm(dir, rel) {
  const combined = dir ? `${dir}/${rel}` : rel;
  const absolute = combined.startsWith('/');
  const stack = [];
  for (const part of combined.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return (absolute ? '/' : '') + stack.join('/');
}

function isAbsolute(p) {
  return /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(p);
}

function isUrl(p) {
  return /^(https?:)?\/\//i.test(p);
}

/** Parse the include target from a line, or null if not an include directive. */
function parseIncludeTarget(line) {
  const m = line.match(/^\s*!include(?:_many|sub|url)?\s+(.+?)\s*$/);
  if (!m) return null;
  let t = m[1].trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1);
  }
  return t;
}

function parseStdlib(target) {
  const m = target.match(/^<([^>]+)>$/);
  if (!m) return null;
  const inner = m[1];
  const slash = inner.indexOf('/');
  if (slash < 0) return null; // bare <something> isn't a namespaced stdlib include
  return { ns: inner.slice(0, slash), path: inner.slice(slash + 1) };
}

async function expand(text, ctx, depth, stack, missingNs) {
  if (depth > MAX_DEPTH) return text;
  const lines = text.split(/\r\n|\r|\n/);
  const out = [];

  for (const line of lines) {
    const target = parseIncludeTarget(line);
    if (target == null || isUrl(target)) {
      out.push(line);
      continue;
    }

    const std = parseStdlib(target);
    if (std) {
      const ext = NS_TO_EXT[std.ns];
      if (!ext) {
        missingNs.add(std.ns);
        out.push(line);
        continue;
      }
      const rel = ensurePuml(std.path);
      const key = `ext:${ext}:${rel}`;
      if (stack.has(key)) {
        out.push(line);
        continue;
      }
      let content;
      try {
        content = await readExtensionFile(ext, rel);
      } catch {
        missingNs.add(std.ns);
        out.push(line);
        continue;
      }
      stack.add(key);
      out.push(
        await expand(content, { kind: 'ext', ext, dir: dirOf(rel) }, depth + 1, stack, missingNs),
      );
      stack.delete(key);
      continue;
    }

    // Relative / absolute include.
    if (ctx.kind === 'ext') {
      // Resolve within the same stdlib extension.
      const rel = ensurePuml(isAbsolute(target) ? target : joinNorm(ctx.dir, target));
      const key = `ext:${ctx.ext}:${rel}`;
      if (stack.has(key)) {
        out.push(line);
        continue;
      }
      let content;
      try {
        content = await readExtensionFile(ctx.ext, rel);
      } catch {
        out.push(line);
        continue;
      }
      stack.add(key);
      out.push(
        await expand(
          content,
          { kind: 'ext', ext: ctx.ext, dir: dirOf(rel) },
          depth + 1,
          stack,
          missingNs,
        ),
      );
      stack.delete(key);
    } else {
      // Local file on disk.
      const path = isAbsolute(target) ? target : joinNorm(ctx.dir, target);
      const candidates = /\.\w+$/.test(path) ? [path] : [path, `${path}.puml`];
      let content = null;
      let used = null;
      for (const cand of candidates) {
        try {
          content = await readFile(cand);
          used = cand;
          break;
        } catch {
          /* try next */
        }
      }
      if (content == null) {
        out.push(line);
        continue;
      }
      const key = `local:${used}`;
      if (stack.has(key)) {
        out.push(line);
        continue;
      }
      stack.add(key);
      out.push(
        await expand(content, { kind: 'local', dir: dirOf(used) }, depth + 1, stack, missingNs),
      );
      stack.delete(key);
    }
  }

  return out.join('\n');
}

/**
 * Recursively expand `!include` directives in `text`.
 * @param {string} text
 * @param {string} [baseDir] directory of the source file (for relative includes)
 * @returns {Promise<{ text: string, missingNamespaces: string[] }>}
 */
export async function resolveIncludes(text, baseDir = '') {
  const missingNs = new Set();
  const resolved = await expand(
    text,
    { kind: 'local', dir: (baseDir || '').replace(/\\/g, '/') },
    0,
    new Set(),
    missingNs,
  );
  return { text: resolved, missingNamespaces: [...missingNs] };
}

// Exported for tests.
export const _internal = { parseIncludeTarget, parseStdlib, joinNorm, ensurePuml };
