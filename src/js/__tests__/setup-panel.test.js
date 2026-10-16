// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  remoteSectionHtml,
  initRemoteSection,
  initWslSection,
  wslStatusText,
} from '../features/remote/setup-panel.js';

function mount(initialHosts, results = {}) {
  document.body.innerHTML = `<div id="root">${remoteSectionHtml()}</div>`;
  const root = document.getElementById('root');
  const saved = [];
  const backend = {
    remoteSetup: vi.fn(async (host, checkOnly) => {
      const r = results[`${host}:${checkOnly}`];
      if (r instanceof Error) throw r;
      return r ?? { ok: true, log: `done ${host}` };
    }),
    getConfig: vi.fn(async () => ({ theme: 'dark', setup_hosts: ['stale'] })),
    saveConfig: vi.fn(async (c) => {
      saved.push(c);
    }),
  };
  initRemoteSection(root, backend, initialHosts);
  const $ = (sel) => root.querySelector(sel);
  const rows = () => [...root.querySelectorAll('.remote-host-row')].map((r) => r.dataset.host);
  return { root, backend, saved, $, rows };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('remote hosts section', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('lists the hosts already set up', () => {
    const { rows } = mount(['k16', 'box']);
    expect(rows()).toEqual(['k16', 'box']);
  });

  it('sets a host up, shows the log, and remembers it', async () => {
    const { backend, saved, $, rows } = mount([]);
    $('#remote-host').value = ' k16 ';
    $('#remote-setup-btn').click();
    expect($('#remote-status').textContent).toMatch(/セットアップしています/);
    expect($('#remote-setup-btn').disabled).toBe(true);
    await flush();
    expect(backend.remoteSetup).toHaveBeenCalledWith('k16', false);
    expect(rows()).toEqual(['k16']);
    expect($('#remote-log').textContent).toBe('done k16');
    expect($('#remote-status').dataset.kind).toBe('ok');
    expect($('#remote-host').value).toBe('');
    expect($('#remote-setup-btn').disabled).toBe(false);
    // Other settings on disk are carried over; only the list is ours.
    expect(saved).toEqual([{ theme: 'dark', setup_hosts: ['k16'] }]);
  });

  it('Enter in the field does the same as the button', async () => {
    const { backend, $ } = mount([]);
    $('#remote-host').value = 'box';
    $('#remote-host').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(backend.remoteSetup).toHaveBeenCalledWith('box', false);
  });

  it('does not call the backend for a bad host name', async () => {
    const { backend, $ } = mount([]);
    for (const bad of ['', '-oProxyCommand=x', 'a b']) {
      $('#remote-host').value = bad;
      $('#remote-setup-btn').click();
      await flush();
      expect($('#remote-status').dataset.kind).toBe('error');
    }
    expect(backend.remoteSetup).not.toHaveBeenCalled();
  });

  it('a failed setup shows why and is not remembered', async () => {
    const { saved, $, rows } = mount([], { 'k16:false': { ok: false, log: 'ssh k16 failed' } });
    $('#remote-host').value = 'k16';
    $('#remote-setup-btn').click();
    await flush();
    expect(rows()).toEqual([]);
    expect(saved).toEqual([]);
    expect($('#remote-log').textContent).toBe('ssh k16 failed');
    expect($('#remote-status').textContent).toMatch(/失敗/);
    expect($('#remote-host').value).toBe('k16');
  });

  it('a backend error is reported and the buttons come back', async () => {
    const { $ } = mount([], { 'k16:false': new Error('fude-cli を実行できません') });
    $('#remote-host').value = 'k16';
    $('#remote-setup-btn').click();
    await flush();
    expect($('#remote-status').textContent).toMatch(/実行できません/);
    expect($('#remote-setup-btn').disabled).toBe(false);
  });

  it('check only asks, and changes neither the list nor the config', async () => {
    const { backend, saved, $, rows } = mount(['k16'], {
      'k16:true': { ok: true, log: 'Fude 0.8.6 answers via tcp://127.0.0.1:47821' },
    });
    $('.remote-check').click();
    await flush();
    expect(backend.remoteSetup).toHaveBeenCalledWith('k16', true);
    expect($('#remote-status').textContent).toMatch(/届きます/);
    expect($('#remote-log').textContent).toMatch(/answers/);
    expect(rows()).toEqual(['k16']);
    expect(saved).toEqual([]);
  });

  it('a check that fails says the host does not reach Fude', async () => {
    const { $ } = mount(['k16'], { 'k16:true': { ok: false, log: 'no Fude GUI reachable' } });
    $('.remote-check').click();
    await flush();
    expect($('#remote-status').textContent).toMatch(/届きません/);
    expect($('#remote-status').dataset.kind).toBe('error');
  });

  it('update re-runs setup without duplicating the row or re-saving', async () => {
    const { backend, saved, $, rows } = mount(['k16']);
    $('.remote-update').click();
    await flush();
    expect(backend.remoteSetup).toHaveBeenCalledWith('k16', false);
    expect(rows()).toEqual(['k16']);
    expect(saved).toEqual([]);
  });

  it('forget drops the row and saves the shorter list', async () => {
    const { backend, saved, $, rows } = mount(['k16', 'box']);
    $('.remote-host-row[data-host="k16"] .remote-forget').click();
    await flush();
    expect(rows()).toEqual(['box']);
    expect(saved).toEqual([{ theme: 'dark', setup_hosts: ['box'] }]);
    expect(backend.remoteSetup).not.toHaveBeenCalled();
  });

  it('ignores clicks while a run is in progress', async () => {
    const { backend, $ } = mount(['k16']);
    $('.remote-check').click();
    $('.remote-update').click();
    $('#remote-host').value = 'box';
    $('#remote-setup-btn').click();
    await flush();
    expect(backend.remoteSetup).toHaveBeenCalledTimes(1);
  });

  it('host names are shown as text, never as markup', () => {
    const { root } = mount(['<img src=x onerror=alert(1)>']);
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('.remote-host-name').textContent).toBe(
      '<img src=x onerror=alert(1)>',
    );
  });
});

describe('wslStatusText', () => {
  it('is empty when integration is off', () => {
    expect(wslStatusText({ distro: null, running: false, log: 'x' })).toBe('');
    expect(wslStatusText(undefined)).toBe('');
  });

  it('describes a running bridge', () => {
    expect(wslStatusText({ distro: 'U', running: true, log: 'fude-cli bridge: a → b' })).toBe(
      '動作中',
    );
    expect(wslStatusText({ distro: 'U', running: true, log: '' })).toBe('動作中');
    expect(
      wslStatusText({
        distro: 'U',
        running: true,
        log: 'fude: downloading fude-cli 0.8.7 into WSL',
      }),
    ).toMatch(/準備中/);
    expect(
      wslStatusText({
        distro: 'U',
        running: true,
        log: 'fude-cli bridge: wrote the GUI token to X — restart Fude on Windows once\nfude-cli bridge: a → b',
      }),
    ).toMatch(/再起動/);
  });

  it('shows why a bridge is not running', () => {
    expect(
      wslStatusText({
        distro: 'U',
        running: false,
        log: 'first\n\nfude-cli bridge: gui.sock is in use\n',
      }),
    ).toBe('停止中: fude-cli bridge: gui.sock is in use');
    expect(wslStatusText({ distro: 'U', running: false, log: '' })).toBe('停止中');
  });
});

describe('WSL integration row', () => {
  function mountWsl(status, setResult) {
    document.body.innerHTML = `<div id="root">${remoteSectionHtml()}</div>`;
    const root = document.getElementById('root');
    const backend = {
      wslBridgeStatus: vi.fn(async () => status),
      wslBridgeSet: vi.fn(async (distro) => {
        if (setResult instanceof Error) throw setResult;
        return setResult ?? { supported: true, distro, running: true, log: '' };
      }),
    };
    return { root, backend, $: (sel) => root.querySelector(sel) };
  }

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('stays hidden where it is not supported', async () => {
    const { root, backend, $ } = mountWsl({ supported: false, distros: [] });
    await initWslSection(root, backend, []);
    expect($('#remote-wsl').style.display).toBe('none');
    expect(backend.wslBridgeStatus).toHaveBeenCalledWith(true);
  });

  it('stays hidden when the backend cannot be asked', async () => {
    const { root, $ } = mountWsl();
    await initWslSection(root, { wslBridgeStatus: vi.fn().mockRejectedValue(new Error('x')) }, []);
    expect($('#remote-wsl').style.display).toBe('none');
  });

  it('lists the distros with the current one selected', async () => {
    const { root, backend, $ } = mountWsl({
      supported: true,
      distros: ['CentOS7', 'Ubuntu-22.04-k'],
      distro: 'Ubuntu-22.04-k',
      running: true,
      log: '',
    });
    await initWslSection(root, backend, []);
    expect($('#remote-wsl').style.display).toBe('');
    expect([...$('#remote-wsl-distro').options].map((o) => o.value)).toEqual([
      '',
      'CentOS7',
      'Ubuntu-22.04-k',
    ]);
    expect($('#remote-wsl-distro').value).toBe('Ubuntu-22.04-k');
    expect($('#remote-wsl-status').textContent).toBe('動作中');
  });

  it('keeps a configured distro selectable even if wsl no longer lists it', async () => {
    const { root, backend, $ } = mountWsl({
      supported: true,
      distros: ['CentOS7'],
      distro: 'Gone',
      running: false,
      log: 'There is no distribution with the supplied name.',
    });
    await initWslSection(root, backend, []);
    expect($('#remote-wsl-distro').value).toBe('Gone');
    expect($('#remote-wsl-status').textContent).toMatch(/^停止中: There is no/);
    expect($('#remote-wsl-status').dataset.kind).toBe('error');
  });

  it('choosing a distro switches it on and follows up on the start', async () => {
    const { root, backend, $ } = mountWsl({
      supported: true,
      distros: ['U'],
      distro: null,
      running: false,
    });
    await initWslSection(root, backend, [0]);
    backend.wslBridgeStatus.mockResolvedValue({
      supported: true,
      distro: 'U',
      running: false,
      log: 'fude-cli bridge: gui.sock is in use',
    });
    const select = $('#remote-wsl-distro');
    select.value = 'U';
    select.dispatchEvent(new Event('change'));
    expect($('#remote-wsl-status').textContent).toBe('起動しています…');
    await flush();
    expect(backend.wslBridgeSet).toHaveBeenCalledWith('U');
    await flush();
    await flush();
    // The follow-up found that it did not stay up, and says why.
    expect(backend.wslBridgeStatus).toHaveBeenLastCalledWith(false);
    expect($('#remote-wsl-status').textContent).toBe('停止中: fude-cli bridge: gui.sock is in use');
    expect(select.disabled).toBe(false);
  });

  it('choosing off switches it off without a follow-up', async () => {
    const { root, backend, $ } = mountWsl(
      { supported: true, distros: ['U'], distro: 'U', running: true },
      { supported: true, distro: null, running: false, log: '' },
    );
    await initWslSection(root, backend, [0]);
    const select = $('#remote-wsl-distro');
    select.value = '';
    select.dispatchEvent(new Event('change'));
    await flush();
    await flush();
    expect(backend.wslBridgeSet).toHaveBeenCalledWith(null);
    expect($('#remote-wsl-status').textContent).toBe('');
    expect(backend.wslBridgeStatus).toHaveBeenCalledTimes(1);
  });

  it('a failure to switch is shown and the control comes back', async () => {
    const { root, backend, $ } = mountWsl(
      { supported: true, distros: ['U'], distro: null, running: false },
      new Error('wsl.exe を実行できません'),
    );
    await initWslSection(root, backend, [0]);
    const select = $('#remote-wsl-distro');
    select.value = 'U';
    select.dispatchEvent(new Event('change'));
    await flush();
    expect($('#remote-wsl-status').textContent).toMatch(/失敗: wsl.exe/);
    expect(select.disabled).toBe(false);
  });
});

describe('更新したら、そのホストの接続を新しい fude-cli で繋ぎ直す', () => {
  function mountWithConns(conns, opts = {}) {
    document.body.innerHTML = `<div id="root">${remoteSectionHtml()}</div>`;
    const root = document.getElementById('root');
    const calls = [];
    let live = conns;
    const backend = {
      remoteSetup: vi.fn(async () => {
        calls.push('setup');
        return opts.setup ?? { ok: true, log: 'done' };
      }),
      getConfig: vi.fn(async () => ({})),
      saveConfig: vi.fn(async () => {}),
      remoteConnections: vi.fn(async () => {
        calls.push('list');
        return live;
      }),
      remoteDisconnect: vi.fn(async (id) => {
        calls.push(`off:${id}`);
        // The connection ends a moment after it is told to.
        if (!opts.stuck) setTimeout(() => (live = live.filter((c) => c.id !== id)), 0);
        return true;
      }),
      remoteOpen: vi.fn(async (host, path) => {
        calls.push(`open:${host}:${path}`);
        return opts.open ?? { ok: true, log: '' };
      }),
    };
    initRemoteSection(root, backend, ['k16'], { gonePoll: [0, 0, 0] });
    return { backend, calls, $: (sel) => root.querySelector(sel) };
  }
  const settle = async () => {
    for (let i = 0; i < 10; i++) await flush();
  };
  const CONNS = [
    { id: 1, host: 'k16', roots: ['/home/u/notes'], origin: 'ssh:k16' },
    { id: 2, host: 'k16', roots: ['/tmp/m.md'], origin: null },
  ];

  it('更新のあと、切ってから同じ場所を開き直す', async () => {
    const { calls, $ } = mountWithConns(CONNS);
    $('.remote-update').click();
    await settle();
    // Opened again only once the old connection is gone: its end would
    // otherwise drop the folder watch the new one asks for.
    const opened = calls.indexOf('open:k16:/home/u/notes');
    expect(calls.slice(0, 3)).toEqual(['setup', 'list', 'off:1']);
    expect(opened).toBeGreaterThan(3);
    expect(calls[opened - 1]).toBe('list');
    expect($('#remote-status').textContent).toMatch(/繋ぎ直しました/);
    expect($('#remote-status').dataset.kind).toBe('ok');
  });

  it('接続確認では繋ぎ直さない', async () => {
    const { calls, $ } = mountWithConns(CONNS);
    $('.remote-check').click();
    await settle();
    expect(calls).toEqual(['setup']);
  });

  it('更新が失敗したら接続には触らない', async () => {
    const { calls, $ } = mountWithConns(CONNS, { setup: { ok: false, log: 'x' } });
    $('.remote-update').click();
    await settle();
    expect(calls).toEqual(['setup']);
  });

  it('繋ぐ接続が無ければ、そのまま完了', async () => {
    const { calls, $ } = mountWithConns([]);
    $('.remote-update').click();
    await settle();
    expect(calls).toEqual(['setup', 'list']);
    expect($('#remote-status').textContent).toBe('k16: セットアップ完了');
  });

  it('古い接続が切れないままなら、待ちきってから開き直す', async () => {
    const { calls } = mountWithConns(CONNS, { stuck: true });
    document.querySelector('.remote-update').click();
    await settle();
    expect(calls.filter((c) => c === 'list')).toHaveLength(4);
    expect(calls.at(-1)).toBe('open:k16:/home/u/notes');
  });

  it('開き直せなかったら、そう知らせる', async () => {
    const { $ } = mountWithConns(CONNS, { open: { ok: false, log: 'no' } });
    $('.remote-update').click();
    await settle();
    expect($('#remote-status').textContent).toMatch(/開き直せませんでした.*\/home\/u\/notes/);
    expect($('#remote-status').dataset.kind).toBe('error');
  });
});
