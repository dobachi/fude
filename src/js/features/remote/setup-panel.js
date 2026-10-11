// setup-panel.js - the controls of the remote view (remote-view.js): run
// `fude-cli setup` for an ssh host from the app instead of a terminal, keep
// the hosts that were set up so they can be re-checked or updated later, and
// open a folder on one of them — or inside WSL — without logging in first.
import {
  hostError,
  addHost,
  removeHost,
  addRecent,
  recentPaths,
  forgetRecent,
  WSL_HOST,
} from '../../core/setup-hosts.js';

/**
 * The places opened from the view, shared by the host rows and the WSL row.
 * `backend` needs getConfig() and saveConfig().
 */
export function createRecentStore(backend, initial) {
  let list = addRecent(initial, '', '');
  // Read-modify-write so settings saved elsewhere meanwhile are kept.
  const persist = async () => {
    const existing = await backend.getConfig();
    await backend.saveConfig({ ...existing, remote_recent: list });
  };
  return {
    paths: (host) => recentPaths(list, host),
    async add(host, path) {
      const next = addRecent(list, host, path);
      if (next.join('\n') === list.join('\n')) return;
      list = next;
      await persist();
    },
    async forget(host) {
      const next = forgetRecent(list, host);
      if (next.length === list.length) return;
      list = next;
      await persist();
    },
  };
}

let datalistSeq = 0;

/** A path field with the remembered places of `host` to pick from. */
function pathField(store, host) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'remote-path';
  input.placeholder = '開くフォルダ / ファイル（空欄はホーム。例: ~/notes）';
  input.spellcheck = false;
  input.autocomplete = 'off';
  const datalist = document.createElement('datalist');
  datalist.id = `remote-paths-${++datalistSeq}`;
  input.setAttribute('list', datalist.id);
  const refresh = () => {
    datalist.textContent = '';
    const paths = store ? store.paths(host) : [];
    for (const p of paths) {
      const opt = document.createElement('option');
      opt.value = p;
      datalist.appendChild(opt);
    }
    // The place opened last is the likeliest to be wanted again.
    if (!input.value && paths.length) input.value = paths[0];
  };
  refresh();
  return { input, datalist, refresh };
}

export function remoteSectionHtml() {
  return `
    <div class="setting-group setting-remote">
      <label>ssh ホスト</label>
      <div class="remote-add">
        <input type="text" id="remote-host" list="remote-host-candidates" placeholder="ssh のホスト名（例: k16, user@host）" spellcheck="false" autocomplete="off" />
        <datalist id="remote-host-candidates"></datalist>
        <button type="button" id="remote-setup-btn">セットアップ</button>
      </div>
      <div class="remote-wsl" id="remote-wsl" style="display:none">
        <span class="remote-wsl-label">WSL 連携</span>
        <select id="remote-wsl-distro"><option value="">オフ</option></select>
        <span class="remote-wsl-status" id="remote-wsl-status" role="status"></span>
        <div class="remote-open-row" id="remote-wsl-open" style="display:none"></div>
        <small class="setting-hint">WSL のディストリビューションを選ぶと、Fude の起動中はその中で中継（<code>fude bridge</code>）を自動で動かします。WSL やそこから ssh した先で開いたファイルがこの Fude に出るようになり、上の「セットアップ」も WSL の ssh で実行されます。</small>
      </div>
      <div class="remote-hosts" id="remote-hosts"></div>
      <div class="remote-status" id="remote-status" role="status"></div>
      <pre class="remote-log" id="remote-log" style="display:none"></pre>
      <small class="setting-hint">ssh で入れるホストを登録すると、そのホストで <code>fude FILE</code> と打つだけでこの Fude に開けます（<code>fude setup HOST</code> と同じ処理）。登録したホストは、ここからフォルダやファイルを指定して開くこともできます。パスワード入力なしで <code>ssh HOST</code> できることが前提です。</small>
    </div>`;
}

/** One line describing a `wslBridgeStatus()` result. */
export function wslStatusText(status) {
  if (!status?.distro) return '';
  const lines = String(status.log || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1] || '';
  if (status.running) {
    if (lines.some((l) => l.includes('restart Fude'))) {
      return '動作中（鍵を WSL のものに揃えました。Fude を一度再起動してください）';
    }
    if (last.includes('downloading')) return '準備中（fude-cli を WSL に入れています…）';
    return '動作中';
  }
  return last ? `停止中: ${last}` : '停止中';
}

/**
 * Wire the WSL integration row inside `root`. It stays hidden unless the
 * backend says it is supported (Windows). `backend` needs wslBridgeStatus()
 * and wslBridgeSet(); `delays` are the re-checks after a change, in ms (the
 * bridge starts in the background and may first have to download).
 */
export async function initWslSection(root, backend, delays = [2000, 6000, 15000], opts = {}) {
  const box = root.querySelector('#remote-wsl');
  const select = root.querySelector('#remote-wsl-distro');
  const statusEl = root.querySelector('#remote-wsl-status');
  if (!box || !select || !statusEl) return;

  let status;
  try {
    status = await backend.wslBridgeStatus(true);
  } catch {
    return;
  }
  if (!status?.supported) return;

  const names = [...(status.distros || [])];
  if (status.distro && !names.includes(status.distro)) names.push(status.distro);
  for (const name of names) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  }
  // Open a place inside the distro: offered while the bridge runs.
  const openRow = root.querySelector('#remote-wsl-open');
  const sharedStatus = root.querySelector('#remote-status');
  const sharedLog = root.querySelector('#remote-log');
  if (openRow && backend.wslOpen) {
    const field = pathField(opts.recent, WSL_HOST);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'remote-open';
    btn.textContent = '開く';
    btn.title = 'WSL の中のフォルダ / ファイルをこの Fude で開く';
    const say = (text, kind, log) => {
      if (sharedStatus) {
        sharedStatus.textContent = text;
        sharedStatus.dataset.kind = kind || '';
      }
      if (sharedLog) {
        sharedLog.textContent = log || '';
        sharedLog.style.display = log ? '' : 'none';
      }
    };
    const open = async () => {
      if (btn.disabled) return;
      const path = field.input.value.trim() || '~';
      btn.disabled = true;
      say(`WSL: ${path} を開いています…`, 'busy');
      try {
        const res = await backend.wslOpen(path);
        if (res?.ok) {
          say(`WSL: ${path} を開きました`, 'ok', '');
          if (opts.recent) await opts.recent.add(WSL_HOST, path);
          field.refresh();
          opts.onOpened?.();
        } else {
          say(`WSL: ${path} を開けませんでした`, 'error', res?.log || '');
        }
      } catch (e) {
        say(`WSL: ${e?.message || e}`, 'error');
      } finally {
        btn.disabled = false;
      }
    };
    btn.addEventListener('click', open);
    field.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        open();
      }
    });
    openRow.append(field.input, field.datalist, btn);
  }
  const show = (st) => {
    select.value = st?.distro || '';
    statusEl.textContent = wslStatusText(st);
    statusEl.dataset.kind = st?.distro ? (st.running ? 'ok' : 'error') : '';
    if (openRow) openRow.style.display = st?.distro && st.running && backend.wslOpen ? '' : 'none';
  };
  show(status);
  box.style.display = '';

  let generation = 0;
  select.addEventListener('change', async () => {
    const mine = ++generation;
    const distro = select.value || null;
    select.disabled = true;
    statusEl.textContent = distro ? '起動しています…' : '';
    statusEl.dataset.kind = '';
    try {
      show(await backend.wslBridgeSet(distro));
    } catch (e) {
      statusEl.textContent = `失敗: ${e?.message || e}`;
      statusEl.dataset.kind = 'error';
      select.disabled = false;
      return;
    }
    select.disabled = false;
    if (!distro) return;
    for (const ms of delays) {
      await new Promise((r) => setTimeout(r, ms));
      // A newer choice, or a closed panel, makes this follow-up moot.
      if (mine !== generation || !select.isConnected) return;
      try {
        show(await backend.wslBridgeStatus(false));
      } catch {
        return;
      }
    }
  });
}

/**
 * Wire the section inside `root`.
 * `backend` needs remoteSetup(host, checkOnly), getConfig() and saveConfig();
 * with remoteOpen(host, path) each host also gets a field to open a place
 * there, and with sshHostCandidates() the host field offers the names in the
 * ssh config. `opts.recent` is a createRecentStore(); `opts.onOpened` runs
 * after something was opened.
 */
export function initRemoteSection(root, backend, initialHosts, opts = {}) {
  const input = root.querySelector('#remote-host');
  const addBtn = root.querySelector('#remote-setup-btn');
  const listEl = root.querySelector('#remote-hosts');
  const statusEl = root.querySelector('#remote-status');
  const logEl = root.querySelector('#remote-log');
  if (!input || !addBtn || !listEl) return;

  let hosts = addHost(initialHosts, '');
  let busy = false;
  // What is typed per host survives the re-renders a run causes.
  const typed = new Map();

  // Names from the ssh config, to pick instead of type.
  const candidatesEl = root.querySelector('#remote-host-candidates');
  let candidates = [];
  const renderCandidates = () => {
    if (!candidatesEl) return;
    candidatesEl.textContent = '';
    for (const name of candidates.filter((c) => !hosts.includes(c))) {
      const opt = document.createElement('option');
      opt.value = name;
      candidatesEl.appendChild(opt);
    }
  };
  if (backend.sshHostCandidates) {
    backend
      .sshHostCandidates()
      .then((names) => {
        candidates = Array.isArray(names) ? names : [];
        renderCandidates();
      })
      .catch(() => {});
  }

  const setStatus = (text, kind) => {
    statusEl.textContent = text;
    statusEl.dataset.kind = kind || '';
  };
  const showLog = (text) => {
    logEl.textContent = text || '';
    logEl.style.display = text ? '' : 'none';
  };

  // Read-modify-write so settings saved elsewhere meanwhile are kept.
  const persist = async () => {
    const existing = await backend.getConfig();
    await backend.saveConfig({ ...existing, setup_hosts: hosts });
  };

  const render = () => {
    listEl.textContent = '';
    for (const host of hosts) {
      const row = document.createElement('div');
      row.className = 'remote-host-row';
      row.dataset.host = host;
      const name = document.createElement('span');
      name.className = 'remote-host-name';
      name.textContent = host;
      row.appendChild(name);
      const button = (label, title, onClick, cls) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.title = title;
        if (cls) b.className = cls;
        b.disabled = busy;
        b.addEventListener('click', onClick);
        row.appendChild(b);
      };
      button(
        '接続確認',
        'このホストから Fude に届くか確かめる',
        () => run(host, true),
        'remote-check',
      );
      button(
        '更新',
        'セットアップをやり直す（fude-cli も入れ直す）',
        () => run(host, false),
        'remote-update',
      );
      button(
        '×',
        '一覧から外す（ホスト側の設定は消しません）',
        () => forget(host),
        'remote-forget icon-btn',
      );
      listEl.appendChild(row);

      if (backend.remoteOpen) {
        const openRow = document.createElement('div');
        openRow.className = 'remote-open-row';
        openRow.dataset.host = host;
        const field = pathField(opts.recent, host);
        if (typed.has(host)) field.input.value = typed.get(host);
        field.input.disabled = busy;
        field.input.addEventListener('input', () => typed.set(host, field.input.value));
        field.input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            open(host, field.input.value);
          }
        });
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'remote-open';
        btn.textContent = '開く';
        btn.title = 'このホストのフォルダ / ファイルをこの Fude で開く';
        btn.disabled = busy;
        btn.addEventListener('click', () => open(host, field.input.value));
        openRow.append(field.input, field.datalist, btn);
        listEl.appendChild(openRow);
      }
    }
    addBtn.disabled = busy;
    input.disabled = busy;
    renderCandidates();
  };

  async function open(host, rawPath) {
    if (busy) return;
    const path = String(rawPath ?? '').trim() || '~';
    typed.set(host, path);
    busy = true;
    render();
    showLog('');
    setStatus(`${host}: ${path} を開いています…`, 'busy');
    let opened = false;
    try {
      const res = await backend.remoteOpen(host, path);
      if (res?.ok) {
        opened = true;
        setStatus(`${host}: ${path} を開きました`, 'ok');
        if (opts.recent) await opts.recent.add(host, path);
      } else {
        showLog(res?.log || '');
        setStatus(`${host}: ${path} を開けませんでした`, 'error');
      }
    } catch (e) {
      setStatus(`${host}: ${e?.message || e}`, 'error');
    } finally {
      busy = false;
      render();
    }
    if (opened) opts.onOpened?.();
  }

  async function run(rawHost, checkOnly) {
    if (busy) return;
    const err = hostError(rawHost);
    if (err) {
      setStatus(err, 'error');
      return;
    }
    const host = String(rawHost).trim();
    busy = true;
    render();
    showLog('');
    setStatus(
      checkOnly
        ? `${host}: 接続を確認しています…`
        : `${host}: セットアップしています…（数十秒かかることがあります）`,
      'busy',
    );
    try {
      const res = await backend.remoteSetup(host, checkOnly);
      showLog(res?.log || '');
      if (res?.ok) {
        setStatus(checkOnly ? `${host}: Fude に届きます` : `${host}: セットアップ完了`, 'ok');
        if (!checkOnly) {
          const next = addHost(hosts, host);
          if (next.length !== hosts.length) {
            hosts = next;
            await persist();
          }
          if (input.value.trim() === host) input.value = '';
        }
      } else {
        setStatus(
          checkOnly ? `${host}: Fude に届きません` : `${host}: セットアップに失敗しました`,
          'error',
        );
      }
    } catch (e) {
      setStatus(`${host}: ${e?.message || e}`, 'error');
    } finally {
      busy = false;
      render();
    }
  }

  async function forget(host) {
    if (busy) return;
    hosts = removeHost(hosts, host);
    typed.delete(host);
    render();
    try {
      await persist();
      if (opts.recent) await opts.recent.forget(host);
      setStatus(`${host} を一覧から外しました`, '');
    } catch (e) {
      setStatus(`保存に失敗しました: ${e?.message || e}`, 'error');
    }
  }

  addBtn.addEventListener('click', () => run(input.value, false));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      run(input.value, false);
    }
  });
  render();
}
