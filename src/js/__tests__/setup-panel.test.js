// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { remoteSectionHtml, initRemoteSection } from '../features/remote/setup-panel.js';

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
