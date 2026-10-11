// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../backend.js', () => ({
  isLocalTauri: vi.fn(() => true),
  getConfig: vi.fn(async () => ({ setup_hosts: ['k16'], remote_recent: ['k16\t~/notes'] })),
  saveConfig: vi.fn(async () => {}),
  remoteSetup: vi.fn(async () => ({ ok: true, log: '' })),
  remoteOpen: vi.fn(async () => ({ ok: true, log: '' })),
  remoteComplete: vi.fn(async () => []),
  remoteConnections: vi.fn(async () => [{ id: 4, host: 'k16', roots: ['/home/u/notes'] }]),
  remoteDisconnect: vi.fn(async () => true),
  sshHostCandidates: vi.fn(async () => ['k16', 'dev']),
  wslBridgeStatus: vi.fn(async () => ({ supported: false, distros: [] })),
  wslBridgeSet: vi.fn(),
  wslOpen: vi.fn(),
}));

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('remote view', () => {
  let view;
  let backend;

  beforeEach(async () => {
    document.body.innerHTML = '';
    backend = await import('../backend.js');
    view = await import('../features/remote/remote-view.js');
    view.closeRemoteView();
    backend.isLocalTauri.mockReturnValue(true);
    vi.clearAllMocks();
  });

  it('leads with opening, then the connections, with setup folded away', async () => {
    await view.openRemoteView();
    await flush();
    const panel = document.querySelector('.remote-panel');
    expect(panel.querySelector('h2').textContent).toBe('リモート接続');
    expect([...panel.querySelectorAll('.remote-heading')].map((h) => h.textContent)).toEqual([
      '開く',
      '接続中',
    ]);
    // Ready to open what was opened last, the cursor in the path.
    expect(panel.querySelector('#remote-target').value).toBe('ssh:k16');
    expect(panel.querySelector('#remote-open-path').value).toBe('~/notes');
    expect(document.activeElement).toBe(panel.querySelector('#remote-open-path'));
    // The connection that is up, with a way to end it.
    expect(panel.querySelector('.remote-connection-row .remote-disconnect')).not.toBeNull();
    // Setup is there but out of the way, and says who needs it.
    const optional = panel.querySelector('details.remote-optional');
    expect(optional.open).toBe(false);
    expect(optional.querySelector('summary').textContent).toMatch(/任意/);
    expect(optional.querySelector('.remote-host-row').dataset.host).toBe('k16');
    expect(optional.querySelector('.remote-lead').textContent).toMatch(/触らなくて構いません/);
  });

  it('offers the ssh config names as destinations', async () => {
    await view.openRemoteView();
    await flush();
    const names = [...document.querySelectorAll('#remote-target option')].map((o) => o.textContent);
    expect(names).toEqual(['k16', 'dev', '別のホストを入力…']);
  });

  it('a host set up in the view becomes a destination at once', async () => {
    await view.openRemoteView();
    await flush();
    document.querySelector('#remote-host').value = 'box';
    document.querySelector('#remote-setup-btn').click();
    await flush();
    const names = [...document.querySelectorAll('#remote-target option')].map((o) => o.textContent);
    expect(names).toContain('box');
  });

  it('the shortcut opens it, and shuts it when it is open', async () => {
    await view.toggleRemoteView();
    expect(document.querySelector('.remote-panel')).not.toBeNull();
    await view.toggleRemoteView();
    expect(document.querySelector('.remote-panel')).toBeNull();
    await view.toggleRemoteView();
    expect(document.querySelectorAll('.remote-panel').length).toBe(1);
  });

  it('opens once however often it is asked', async () => {
    await Promise.all([view.openRemoteView(), view.openRemoteView()]);
    await view.openRemoteView();
    expect(document.querySelectorAll('.remote-panel').length).toBe(1);
  });

  it('closes on the button, on Escape, and on a click outside', async () => {
    await view.openRemoteView();
    document.querySelector('.remote-panel .settings-close').click();
    expect(document.querySelector('.remote-panel')).toBeNull();

    await view.openRemoteView();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.remote-panel')).toBeNull();

    await view.openRemoteView();
    const overlay = document.querySelector('.remote-overlay');
    // A press inside the panel is not a dismissal.
    overlay
      .querySelector('.remote-panel')
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(document.querySelector('.remote-panel')).not.toBeNull();
    overlay.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(document.querySelector('.remote-panel')).toBeNull();
  });

  it('Escape with the suggestions open closes those first', async () => {
    backend.remoteComplete.mockResolvedValue(['~/notes/a.md']);
    await view.openRemoteView();
    const input = document.querySelector('#remote-open-path');
    input.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 250));
    expect(document.querySelectorAll('#remote-suggest li').length).toBe(1);
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(document.querySelector('.remote-panel')).not.toBeNull();
    expect(document.querySelectorAll('#remote-suggest li').length).toBe(0);
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(document.querySelector('.remote-panel')).toBeNull();
  });

  it('gets out of the way once something was opened', async () => {
    await view.openRemoteView();
    document.querySelector('#remote-open-btn').click();
    await flush();
    expect(backend.remoteOpen).toHaveBeenCalledWith('k16', '~/notes');
    expect(document.querySelector('.remote-panel')).toBeNull();
  });

  it('stays open when opening failed, so the reason can be read', async () => {
    backend.remoteOpen.mockResolvedValueOnce({ ok: false, log: 'ssh: no route' });
    await view.openRemoteView();
    document.querySelector('#remote-open-btn').click();
    await flush();
    expect(document.querySelector('.remote-panel #remote-open-log').textContent).toBe(
      'ssh: no route',
    );
  });

  it('stops asking for connections once closed', async () => {
    vi.useFakeTimers();
    await view.openRemoteView();
    await vi.advanceTimersByTimeAsync(2100);
    const asked = backend.remoteConnections.mock.calls.length;
    expect(asked).toBeGreaterThanOrEqual(2);
    view.closeRemoteView();
    await vi.advanceTimersByTimeAsync(6000);
    expect(backend.remoteConnections.mock.calls.length).toBe(asked);
    vi.useRealTimers();
  });

  it('does nothing outside the desktop app', async () => {
    backend.isLocalTauri.mockReturnValue(false);
    await view.openRemoteView();
    expect(document.querySelector('.remote-panel')).toBeNull();
    expect(backend.getConfig).not.toHaveBeenCalled();
  });

  it('still opens when the config cannot be read', async () => {
    backend.getConfig.mockRejectedValueOnce(new Error('nope'));
    await view.openRemoteView();
    expect(document.querySelector('.remote-panel #remote-open-path')).not.toBeNull();
    expect(document.querySelector('.remote-host-row')).toBeNull();
  });
});
