import { describe, it, expect, vi } from 'vitest';

vi.mock('../backend.js', () => ({
  readExtensionFile: vi.fn(async (id, rel) => {
    const fs = {
      'plantuml-archimate': {
        'Archimate.puml': 'ARCH_TOP\n!include <archimate/themes/shared_style>\n',
        'themes/shared_style.puml': 'SHARED_STYLE\n',
      },
    };
    const f = fs[id]?.[rel];
    if (f == null) throw new Error(`not found ${id} ${rel}`);
    return f;
  }),
  readFile: vi.fn(async (p) => {
    const fs = { '/docs/common.puml': 'COMMON_CONTENT\n' };
    if (fs[p] == null) throw new Error('nf');
    return fs[p];
  }),
}));

import { resolveIncludes } from '../features/plantuml/includes.js';

describe('resolveIncludes', () => {
  it('expands a stdlib archimate include recursively', async () => {
    const { text, missingNamespaces } = await resolveIncludes(
      '@startuml\n!include <archimate/Archimate>\n@enduml',
      '',
    );
    expect(missingNamespaces).toEqual([]);
    expect(text).toContain('ARCH_TOP');
    expect(text).toContain('SHARED_STYLE');
    expect(text).not.toMatch(/!include/);
  });

  it('reports a missing namespace for an unknown/uninstalled stdlib', async () => {
    const { missingNamespaces } = await resolveIncludes('!include <C4/C4_Context>', '');
    expect(missingNamespaces).toContain('C4');
  });

  it('expands a local relative include against the base dir', async () => {
    const { text } = await resolveIncludes('!include ./common.puml', '/docs');
    expect(text).toContain('COMMON_CONTENT');
  });

  it('leaves URL includes untouched (no network)', async () => {
    const src = '!includeurl https://example.com/x.puml';
    const { text } = await resolveIncludes(src, '');
    expect(text).toContain(src);
  });

  it('keeps non-include text unchanged', async () => {
    const { text } = await resolveIncludes('@startuml\nA -> B\n@enduml', '');
    expect(text).toBe('@startuml\nA -> B\n@enduml');
  });
});
