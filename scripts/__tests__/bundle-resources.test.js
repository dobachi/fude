// @vitest-environment node
//
// The installed fude-browser runs serve.js from the app bundle, next to only
// the files tauri.conf.json lists. A lib that serve.js requires but the bundle
// omits works in the repo and in every test here, then crashes on startup once
// installed. Keep the two in step.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const repo = path.resolve(__dirname, '..', '..');

describe('browser-mode bundle', () => {
  it('ships every local module serve.js requires', () => {
    const serve = fs.readFileSync(path.join(repo, 'scripts', 'serve.js'), 'utf8');
    const required = [...serve.matchAll(/require\('\.\/(lib\/[\w.-]+?)(?:\.js)?'\)/g)].map(
      (m) => `browser/${m[1]}.js`,
    );
    expect(required.length).toBeGreaterThan(0);

    const conf = JSON.parse(
      fs.readFileSync(path.join(repo, 'src-tauri', 'tauri.conf.json'), 'utf8'),
    );
    const bundled = Object.values(conf.bundle.resources);
    for (const target of required) expect(bundled).toContain(target);
  });
});
