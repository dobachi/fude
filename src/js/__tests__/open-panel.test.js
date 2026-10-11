// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  openSectionHtml,
  connectionsHtml,
  initOpenSection,
  initConnections,
  createRecentStore,
  rootsText,
  splitForDisplay,
} from '../features/remote/open-panel.js';

const flush = () => new Promise((r) => setTimeout(r, 0));
const key = (el, k, extra = {}) => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra });
  el.dispatchEvent(e);
  return e;
};

function mount({
  recent = [],
  setupHosts = ['k16'],
  completions = {},
  open,
  wslOpen,
  preset,
} = {}) {
  document.body.innerHTML = `<div id="root">${openSectionHtml()}</div>`;
  const root = document.getElementById('root');
  const saved = [];
  const backend = {
    remoteOpen: vi.fn(async (host, path) => {
      const r = typeof open === 'function' ? open(host, path) : open;
      if (r instanceof Error) throw r;
      return r ?? { ok: true, log: '' };
    }),
    wslOpen: vi.fn(async () => wslOpen ?? { ok: true, log: '' }),
    remoteComplete: vi.fn(async (host, partial) => completions[`${host}|${partial}`] ?? []),
    getConfig: vi.fn(async () => ({ theme: 'dark' })),
    saveConfig: vi.fn(async (c) => {
      saved.push(c);
    }),
  };
  const store = createRecentStore(backend, recent);
  const onOpened = vi.fn();
  const api = initOpenSection(root, backend, {
    recent: store,
    setupHosts,
    onOpened,
    debounce: 0,
    preset,
  });
  const $ = (sel) => root.querySelector(sel);
  const targets = () => [...$('#remote-target').options].map((o) => o.textContent);
  const suggestions = () =>
    [...root.querySelectorAll('#remote-suggest li')].map((l) => l.textContent);
  const type = async (text) => {
    $('#remote-open-path').value = text;
    $('#remote-open-path').dispatchEvent(new Event('input'));
    await flush();
  };
  return { root, backend, saved, onOpened, api, $, targets, suggestions, type };
}

describe('open section: destination', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('offers the known hosts and a way to name another', () => {
    const { targets, $ } = mount({ setupHosts: ['k16', 'dev'] });
    expect(targets()).toEqual(['k16', 'dev', '別のホストを入力…']);
    expect($('#remote-target').value).toBe('ssh:k16');
    expect($('#remote-target-host').style.display).toBe('none');
  });

  it('starts on the place opened last, its path filled in', () => {
    const { $, targets } = mount({
      recent: ['dev\t~/work', 'k16\t~/notes'],
      setupHosts: ['k16'],
    });
    expect(targets()).toEqual(['dev', 'k16', '別のホストを入力…']);
    expect($('#remote-target').value).toBe('ssh:dev');
    expect($('#remote-open-path').value).toBe('~/work');
  });

  it("switching destination brings that place's last path", () => {
    const { $ } = mount({ recent: ['dev\t~/work', 'k16\t~/notes'] });
    $('#remote-target').value = 'ssh:k16';
    $('#remote-target').dispatchEvent(new Event('change'));
    expect($('#remote-open-path').value).toBe('~/notes');
  });

  it('names from the ssh config and newly set up hosts join the list', () => {
    const { api, targets } = mount({ setupHosts: [] });
    expect(targets()).toEqual(['別のホストを入力…']);
    api.setCandidates(['git', 'k16']);
    api.setHosts(['box']);
    expect(targets()).toEqual(['box', 'git', 'k16', '別のホストを入力…']);
  });

  it('WSL is a destination only where integration names a distro', () => {
    const { api, targets } = mount();
    api.setWsl({ supported: true, distro: null });
    expect(targets()).not.toContain('WSL（Ubuntu）');
    api.setWsl({ supported: true, distro: 'Ubuntu', running: false });
    expect(targets()).toEqual(['k16', 'WSL（Ubuntu）', '別のホストを入力…']);
    api.setWsl({ supported: false, distro: 'Ubuntu' });
    expect(targets()).toEqual(['k16', '別のホストを入力…']);
  });

  it('starts where it was asked to, even on a host not yet listed', () => {
    const { $, targets } = mount({
      recent: ['dev\t~/work'],
      preset: { kind: 'ssh', host: 'me@box', path: '/srv/docs/' },
    });
    expect(targets()[0]).toBe('me@box');
    expect($('#remote-target').value).toBe('ssh:me@box');
    expect($('#remote-open-path').value).toBe('/srv/docs/');
  });

  it('a WSL start waits for the distro to be known, then takes it', () => {
    const { api, $ } = mount({ preset: { kind: 'wsl', path: '~/Sources/' } });
    expect($('#remote-target').value).toBe('ssh:k16');
    api.setWsl({ supported: true, distro: 'Ubuntu' });
    expect($('#remote-target').value).toBe('wsl');
  });

  it('picking another destination lets go of the one asked for', () => {
    const { api, $ } = mount({ preset: { kind: 'ssh', host: 'box', path: '/srv/' } });
    $('#remote-target').value = 'ssh:k16';
    $('#remote-target').dispatchEvent(new Event('change'));
    api.setCandidates(['git']);
    expect($('#remote-target').value).toBe('ssh:k16');
  });

  it('another host is typed in, and checked before anything runs', async () => {
    const { $, backend } = mount();
    $('#remote-target').value = 'other';
    $('#remote-target').dispatchEvent(new Event('change'));
    expect($('#remote-target-host').style.display).toBe('');
    $('#remote-open-btn').click();
    await flush();
    expect($('#remote-open-status').textContent).toMatch(/入力/);
    $('#remote-target-host').value = 'bad host';
    $('#remote-open-btn').click();
    await flush();
    expect($('#remote-open-status').dataset.kind).toBe('error');
    expect(backend.remoteOpen).not.toHaveBeenCalled();
    $('#remote-target-host').value = 'me@box';
    $('#remote-open-path').value = '/srv';
    $('#remote-open-btn').click();
    await flush();
    expect(backend.remoteOpen).toHaveBeenCalledWith('me@box', '/srv');
  });
});

describe('open section: opening', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('opens the path, remembers it first, and tells the view', async () => {
    const { backend, saved, onOpened, $ } = mount({ recent: ['k16\t~/notes', 'box\t/b'] });
    $('#remote-open-path').value = ' /srv ';
    $('#remote-open-btn').click();
    expect($('#remote-open-status').textContent).toMatch(/\/srv を開いています/);
    expect($('#remote-open-btn').disabled).toBe(true);
    await flush();
    expect(backend.remoteOpen).toHaveBeenCalledWith('k16', '/srv');
    expect($('#remote-open-status').dataset.kind).toBe('ok');
    expect(saved).toEqual([
      { theme: 'dark', remote_recent: ['k16\t/srv', 'k16\t~/notes', 'box\t/b'] },
    ]);
    expect(onOpened).toHaveBeenCalledTimes(1);
    expect($('#remote-open-btn').disabled).toBe(false);
  });

  it('an empty path means the home directory', async () => {
    const { backend, $ } = mount();
    $('#remote-open-btn').click();
    await flush();
    expect(backend.remoteOpen).toHaveBeenCalledWith('k16', '~');
  });

  it('Enter in the path field opens', async () => {
    const { backend, $ } = mount();
    $('#remote-open-path').value = '~/x';
    key($('#remote-open-path'), 'Enter');
    await flush();
    expect(backend.remoteOpen).toHaveBeenCalledWith('k16', '~/x');
  });

  it('WSL goes through wslOpen and is remembered under wsl', async () => {
    const { api, backend, saved, $ } = mount();
    api.setWsl({ supported: true, distro: 'Ubuntu', running: true });
    $('#remote-target').value = 'wsl';
    $('#remote-target').dispatchEvent(new Event('change'));
    $('#remote-open-path').value = '~/Sources';
    $('#remote-open-btn').click();
    await flush();
    expect(backend.wslOpen).toHaveBeenCalledWith('~/Sources');
    expect(backend.remoteOpen).not.toHaveBeenCalled();
    expect(saved[0].remote_recent).toEqual(['wsl\t~/Sources']);
  });

  it('a failure shows what the far side said, keeps the path, and stays', async () => {
    const { saved, onOpened, $ } = mount({
      open: { ok: false, log: 'fude-cli: /nope: no such file or directory' },
    });
    $('#remote-open-path').value = '/nope';
    $('#remote-open-btn').click();
    await flush();
    expect($('#remote-open-status').dataset.kind).toBe('error');
    expect($('#remote-open-log').textContent).toMatch(/no such file/);
    expect($('#remote-open-log').style.display).toBe('');
    expect($('#remote-open-path').value).toBe('/nope');
    expect(saved).toEqual([]);
    expect(onOpened).not.toHaveBeenCalled();
  });

  it('a backend error is reported and the controls come back', async () => {
    const { onOpened, $ } = mount({ open: new Error('boom') });
    $('#remote-open-btn').click();
    await flush();
    expect($('#remote-open-status').textContent).toMatch(/boom/);
    expect($('#remote-open-btn').disabled).toBe(false);
    expect(onOpened).not.toHaveBeenCalled();
  });

  it('ignores a second request while one is running', async () => {
    const { backend, $ } = mount();
    $('#remote-open-btn').click();
    $('#remote-open-btn').click();
    key($('#remote-open-path'), 'Enter');
    await flush();
    expect(backend.remoteOpen).toHaveBeenCalledTimes(1);
  });
});

describe('open section: path completion', () => {
  const completions = {
    'k16|~/S': ['~/Sandbox/', '~/Sources/', '~/Summary.md'],
    'k16|~/So': ['~/Sources/'],
    'k16|~/Sources/': ['~/Sources/fude/', '~/Sources/readme.md'],
    'null|~/S': ['~/Stuff/'],
  };

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('asks the chosen host as the path is typed and lists the answers', async () => {
    const { backend, suggestions, type, $ } = mount({ completions });
    await type('~/S');
    expect(backend.remoteComplete).toHaveBeenCalledWith('k16', '~/S');
    expect(suggestions()).toEqual(['~/Sandbox/', '~/Sources/', '~/Summary.md']);
    expect($('#remote-open-path').getAttribute('aria-expanded')).toBe('true');
  });

  it('puts places opened before ahead of the completions', async () => {
    const { suggestions, type } = mount({ completions, recent: ['k16\t~/Sources/fude'] });
    await type('~/S');
    expect(suggestions()[0]).toBe('~/Sources/fude');
  });

  it('asks inside WSL when that is the destination', async () => {
    const { api, backend, suggestions, type, $ } = mount({ completions });
    api.setWsl({ supported: true, distro: 'Ubuntu' });
    $('#remote-target').value = 'wsl';
    $('#remote-target').dispatchEvent(new Event('change'));
    await type('~/S');
    expect(backend.remoteComplete).toHaveBeenLastCalledWith(null, '~/S');
    expect(suggestions()).toEqual(['~/Stuff/']);
  });

  it('Tab completes as far as the candidates agree, then takes the only one', async () => {
    const { $, type, suggestions } = mount({
      completions: { ...completions, 'k16|~/': ['~/Sandbox/', '~/Sources/'] },
    });
    const input = $('#remote-open-path');
    await type('~/');
    const e = key(input, 'Tab');
    expect(e.defaultPrevented).toBe(true);
    expect(input.value).toBe('~/S');
    await flush();
    await type('~/So');
    expect(suggestions()).toEqual(['~/Sources/']);
    key(input, 'Tab');
    expect(input.value).toBe('~/Sources/');
    // A directory invites the next level.
    await flush();
    expect(suggestions()).toEqual(['~/Sources/fude/', '~/Sources/readme.md']);
  });

  it('Tab with nothing to offer moves on as usual', async () => {
    const { $, type } = mount({ completions });
    await type('/zzz');
    expect(key($('#remote-open-path'), 'Tab').defaultPrevented).toBe(false);
  });

  it('arrows pick one, Enter takes it without opening, Enter again opens', async () => {
    const { backend, $, type, root } = mount({ completions });
    const input = $('#remote-open-path');
    await type('~/S');
    key(input, 'ArrowDown');
    key(input, 'ArrowDown');
    expect(root.querySelector('#remote-suggest li.active').textContent).toBe('~/Sources/');
    key(input, 'ArrowUp');
    expect(root.querySelector('#remote-suggest li.active').textContent).toBe('~/Sandbox/');
    key(input, 'ArrowUp'); // wraps to the last
    expect(root.querySelector('#remote-suggest li.active').textContent).toBe('~/Summary.md');
    key(input, 'Enter');
    expect(input.value).toBe('~/Summary.md');
    expect(backend.remoteOpen).not.toHaveBeenCalled();
    key(input, 'Enter');
    await flush();
    expect(backend.remoteOpen).toHaveBeenCalledWith('k16', '~/Summary.md');
  });

  it('a click takes a suggestion', async () => {
    const { $, type, root } = mount({ completions });
    await type('~/S');
    const li = root.querySelectorAll('#remote-suggest li')[1];
    li.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect($('#remote-open-path').value).toBe('~/Sources/');
  });

  it('Escape closes the list only, and is passed on once it is closed', async () => {
    const { $, type, suggestions } = mount({ completions });
    const input = $('#remote-open-path');
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    await type('~/S');
    key(input, 'Escape');
    expect(suggestions()).toEqual([]);
    expect(outer).not.toHaveBeenCalled();
    key(input, 'Escape');
    expect(outer).toHaveBeenCalledTimes(1);
    document.removeEventListener('keydown', outer);
  });

  it('an answer that arrives after more typing is dropped', async () => {
    let release;
    const slow = new Promise((r) => {
      release = r;
    });
    const { backend, $, suggestions } = mount();
    backend.remoteComplete.mockImplementationOnce(async () => {
      await slow;
      return ['~/Stale/'];
    });
    const input = $('#remote-open-path');
    input.value = '~/S';
    input.dispatchEvent(new Event('input'));
    await flush();
    backend.remoteComplete.mockImplementationOnce(async () => ['~/Sources/']);
    input.value = '~/So';
    input.dispatchEvent(new Event('input'));
    await flush();
    release();
    await flush();
    expect(suggestions()).toEqual(['~/Sources/']);
  });

  it('a completion that fails leaves the earlier places to pick from', async () => {
    const { backend, suggestions, type } = mount({ recent: ['k16\t~/notes'] });
    backend.remoteComplete.mockRejectedValueOnce(new Error('no route'));
    await type('~/n');
    expect(suggestions()).toEqual(['~/notes']);
  });

  it('shows a long path whole, its name set apart from its folder', async () => {
    const long = '~/Sources/DevMarkdownEditor/projects/fude/src-tauri/crates/fude-cli/src/tui/';
    const { root, type } = mount({ completions: { 'k16|x': [long, 'plain.md'] } });
    await type('x');
    const [first, second] = root.querySelectorAll('#remote-suggest li');
    // Nothing is dropped: the parts read back as the path, and hovering shows it.
    expect(first.textContent).toBe(long);
    expect(first.title).toBe(long);
    expect(first.querySelector('.remote-suggest-dir').textContent).toBe(
      '~/Sources/DevMarkdownEditor/projects/fude/src-tauri/crates/fude-cli/src/',
    );
    expect(first.querySelector('.remote-suggest-name').textContent).toBe('tui/');
    expect(second.querySelector('.remote-suggest-dir')).toBeNull();
    expect(second.querySelector('.remote-suggest-name').textContent).toBe('plain.md');
  });

  it('splits a path into folder and name for display', () => {
    expect(splitForDisplay('~/a/b/')).toEqual({ dir: '~/a/', name: 'b/' });
    expect(splitForDisplay('~/a/b.md')).toEqual({ dir: '~/a/', name: 'b.md' });
    expect(splitForDisplay('/x')).toEqual({ dir: '/', name: 'x' });
    expect(splitForDisplay('notes/')).toEqual({ dir: '', name: 'notes/' });
    expect(splitForDisplay('/')).toEqual({ dir: '', name: '/' });
    expect(splitForDisplay('')).toEqual({ dir: '', name: '' });
  });

  it('paths are shown as text, never as markup', async () => {
    const { root, type } = mount({ completions: { 'k16|x': ['<img src=x onerror=alert(1)>/'] } });
    await type('x');
    expect(root.querySelector('#remote-suggest img')).toBeNull();
    expect(root.querySelector('#remote-suggest li').textContent).toBe(
      '<img src=x onerror=alert(1)>/',
    );
  });
});

describe('connections', () => {
  function mountConns(lists) {
    document.body.innerHTML = `<div id="root">${connectionsHtml()}</div>`;
    const root = document.getElementById('root');
    let n = 0;
    const backend = {
      remoteConnections: vi.fn(async () => lists[Math.min(n++, lists.length - 1)]),
      remoteDisconnect: vi.fn(async () => true),
    };
    const api = initConnections(root, backend, { interval: 0 });
    const rows = () =>
      [...root.querySelectorAll('.remote-connection-row')].map((r) => [
        r.querySelector('.remote-host-name').textContent,
        r.querySelector('.remote-connection-roots').textContent,
      ]);
    return { root, backend, api, rows };
  }

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('says so when nothing is connected', async () => {
    const { root, rows } = mountConns([[]]);
    await flush();
    expect(rows()).toEqual([]);
    expect(root.textContent).toMatch(/接続中のリモートはありません/);
  });

  it('lists each connection with what it serves', async () => {
    const { rows } = mountConns([
      [
        { id: 3, host: 'k16', roots: ['/home/u/notes'] },
        { id: 5, host: 'home', roots: ['/a', '/b'] },
      ],
    ]);
    await flush();
    expect(rows()).toEqual([
      ['k16', '/home/u/notes'],
      ['home', '/a、/b'],
    ]);
  });

  it('disconnect ends that one and the list follows', async () => {
    const one = { id: 3, host: 'k16', roots: ['/n'] };
    const { root, backend, rows } = mountConns([[one, { id: 5, host: 'box', roots: [] }], [one]]);
    await flush();
    root.querySelector('.remote-connection-row[data-id="5"] .remote-disconnect').click();
    await flush();
    expect(backend.remoteDisconnect).toHaveBeenCalledWith(5);
    expect(rows()).toEqual([['k16', '/n']]);
  });

  it('a list that cannot be read keeps what is shown', async () => {
    const { backend, api, rows } = mountConns([[{ id: 1, host: 'k16', roots: ['/n'] }]]);
    await flush();
    backend.remoteConnections.mockRejectedValueOnce(new Error('x'));
    await api.refresh();
    expect(rows()).toEqual([['k16', '/n']]);
  });

  it('re-reads on a timer until stopped', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<div id="root">${connectionsHtml()}</div>`;
    const backend = { remoteConnections: vi.fn(async () => []), remoteDisconnect: vi.fn() };
    const api = initConnections(document.getElementById('root'), backend, { interval: 1000 });
    await vi.advanceTimersByTimeAsync(2500);
    expect(backend.remoteConnections).toHaveBeenCalledTimes(3);
    api.stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(backend.remoteConnections).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('names a connection that announced no place', () => {
    expect(rootsText([])).toBe('（場所は不明）');
    expect(rootsText(null)).toBe('（場所は不明）');
    expect(rootsText(['/a'])).toBe('/a');
  });
});
