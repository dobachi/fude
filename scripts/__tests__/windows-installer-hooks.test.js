// @vitest-environment node
//
// The NSIS installer rewrites the "Open with" command Windows remembers for
// fude.exe (HKCU\Software\Classes\Applications\fude.exe). Without it, a value
// left over from an older install location (e.g. the MSI's C:\Program Files\Fude)
// makes .md files fail with "application not found". NSIS only runs on the
// Windows CI build, so guard the wiring and the key script lines here.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const repo = path.resolve(__dirname, '..', '..');
const conf = JSON.parse(fs.readFileSync(path.join(repo, 'src-tauri', 'tauri.conf.json'), 'utf8'));

describe('Windows installer hooks', () => {
  const rel = conf.bundle?.windows?.nsis?.installerHooks;
  const file = rel && path.join(repo, 'src-tauri', rel);
  const nsh = file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const KEY = 'Software\\Classes\\Applications\\${MAINBINARYNAME}.exe';

  it('tauri.conf.json points at an existing hooks file', () => {
    expect(rel).toBeTruthy();
    expect(fs.existsSync(file)).toBe(true);
  });

  it('rewrites the remembered "Open with" command to the installed exe', () => {
    expect(nsh).toMatch(/!macro NSIS_HOOK_POSTINSTALL[\s\S]*?!macroend/);
    expect(nsh).toContain(
      `WriteRegStr HKCU "${KEY}\\shell\\open\\command" "" '"$INSTDIR\\\${MAINBINARYNAME}.exe" "%1"'`,
    );
  });

  it('on uninstall, removes the key only when it points here and not during updates', () => {
    const un = nsh.match(/!macro NSIS_HOOK_POSTUNINSTALL([\s\S]*?)!macroend/);
    expect(un).not.toBeNull();
    expect(un[1]).toContain('$UpdateMode <> 1');
    expect(un[1]).toContain(`$R0 == '"$INSTDIR\\\${MAINBINARYNAME}.exe" "%1"'`);
    expect(un[1]).toContain(`DeleteRegKey HKCU "${KEY}"`);
  });

  it('keeps the file-association ProgId the hook relies on', () => {
    expect(conf.bundle.fileAssociations[0].ext).toContain('md');
  });
});
