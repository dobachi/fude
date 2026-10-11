// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../backend.js', () => ({
  isLocalTauri: vi.fn(() => true),
  getConfig: vi.fn(async () => ({ setup_hosts: ['k16'], remote_recent: ['k16\t~/notes'] })),
  saveConfig: vi.fn(async () => {}),
  remoteSetup: vi.fn(async () => ({ ok: true, log: '' })),
  remoteOpen: vi.fn(async () => ({ ok: true, log: '' })),
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

  it('shows the hosts with what was opened there last', async () => {
    await view.openRemoteView();
    const panel = document.querySelector('.remote-panel');
    expect(panel).not.toBeNull();
    expect(panel.querySelector('h2').textContent).toBe('リモート接続');
    expect(panel.querySelector('.remote-host-row').dataset.host).toBe('k16');
    expect(panel.querySelector('.remote-open-row .remote-path').value).toBe('~/notes');
    expect(document.activeElement).toBe(panel.querySelector('#remote-host'));
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

  it('gets out of the way once something was opened', async () => {
    await view.openRemoteView();
    document.querySelector('.remote-open-row .remote-open').click();
    await flush();
    expect(backend.remoteOpen).toHaveBeenCalledWith('k16', '~/notes');
    expect(document.querySelector('.remote-panel')).toBeNull();
  });

  it('stays open when opening failed, so the reason can be read', async () => {
    backend.remoteOpen.mockResolvedValueOnce({ ok: false, log: 'ssh: no route' });
    await view.openRemoteView();
    document.querySelector('.remote-open-row .remote-open').click();
    await flush();
    expect(document.querySelector('.remote-panel #remote-log').textContent).toBe('ssh: no route');
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
    expect(document.querySelector('.remote-panel #remote-host')).not.toBeNull();
    expect(document.querySelector('.remote-host-row')).toBeNull();
  });
});
