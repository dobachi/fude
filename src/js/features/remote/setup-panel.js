// setup-panel.js - the optional part of the remote view (remote-view.js):
// what makes `fude FILE` typed in a terminal *on* a host, or inside WSL,
// open in this window. Runs `fude-cli setup` for an ssh host from the app
// instead of a terminal, keeps the hosts that were set up so they can be
// re-checked or updated later, and switches WSL integration.
// Opening a place from here needs none of this: see open-panel.js.
import { hostError, addHost, removeHost, reconnectTargets } from '../../core/setup-hosts.js';

export function remoteSectionHtml() {
  return `
    <div class="setting-group setting-remote remote-setup">
      <p class="remote-lead">ホストの端末（ssh でログインした先）で <code>fude FILE</code> と打って、この Fude に開きたい場合だけ必要な設定です。上の「開く」だけを使うなら、ここは触らなくて構いません。</p>
      <label>ssh ホスト</label>
      <div class="remote-add">
        <input type="text" id="remote-host" placeholder="ssh のホスト名（例: k16, user@host）" spellcheck="false" autocomplete="off" />
        <button type="button" id="remote-setup-btn">セットアップ</button>
      </div>
      <small class="setting-hint">ホストに <code>fude-cli</code> を入れ、そのホストから この Fude へ戻る経路（ssh の転送）を <code>~/.ssh/config</code> に書きます（<code>fude setup HOST</code> と同じ）。パスワード入力なしで <code>ssh HOST</code> できることが前提です。</small>
      <div class="remote-hosts" id="remote-hosts"></div>
      <div class="remote-status" id="remote-status" role="status"></div>
      <pre class="remote-log" id="remote-log" style="display:none"></pre>
      <div class="remote-wsl" id="remote-wsl" style="display:none">
        <span class="remote-wsl-label">WSL 連携</span>
        <select id="remote-wsl-distro"><option value="">オフ</option></select>
        <span class="remote-wsl-status" id="remote-wsl-status" role="status"></span>
        <small class="setting-hint">ディストリビューションを選ぶと、WSL の端末や、そこから ssh した先で <code>fude FILE</code> と打ったものが この Fude に開きます（Fude の起動中、WSL の中で中継 <code>fude bridge</code> を自動で動かします）。上の「セットアップ」と「開く」の ssh も、WSL の中のものを使うようになります。</small>
      </div>
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
  const show = (st) => {
    select.value = st?.distro || '';
    statusEl.textContent = wslStatusText(st);
    statusEl.dataset.kind = st?.distro ? (st.running ? 'ok' : 'error') : '';
    // The open section offers the distro as a place to open.
    opts.onChange?.(st);
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
 * `backend` needs remoteSetup(host, checkOnly), getConfig() and saveConfig(),
 * and remoteConnections(), remoteDisconnect(id) and remoteOpen(host, path)
 * to reconnect after an update.
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
  // Waits (ms) between checks that the connections cut after an update ended.
  const gonePoll = opts.gonePoll ?? [100, 200, 400, 800, 1500];

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
    // The open section lists these hosts among its destinations.
    opts.onHosts?.(hosts);
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
    }
    addBtn.disabled = busy;
    input.disabled = busy;
  };

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
          await reconnect(host);
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

  /**
   * The places open on `host` are served by the fude-cli that was running
   * before the update. Cut those connections and open the places again, so
   * the new one serves them (an old agent lacks what the update brought).
   */
  async function reconnect(host) {
    if (typeof backend.remoteConnections !== 'function') return;
    let targets;
    try {
      targets = reconnectTargets(await backend.remoteConnections(), host);
    } catch {
      return;
    }
    if (!targets.ids.length) return;
    setStatus(`${host}: セットアップ完了。接続を繋ぎ直しています…`, 'busy');
    for (const id of targets.ids) {
      try {
        await backend.remoteDisconnect(id);
      } catch {
        /* gone already */
      }
    }
    await untilGone(targets.ids);
    const failed = [];
    for (const path of targets.roots) {
      try {
        const res = await backend.remoteOpen(host, path);
        if (!res?.ok) failed.push(path);
      } catch {
        failed.push(path);
      }
    }
    if (failed.length) {
      setStatus(
        `${host}: セットアップ完了。開き直せませんでした: ${failed.join(', ')}（「開く」から開き直してください）`,
        'error',
      );
    } else {
      setStatus(`${host}: セットアップ完了。新しい fude-cli で繋ぎ直しました`, 'ok');
    }
  }

  /**
   * Wait for the connections `ids` to end. Each ends a moment after it is
   * told to, and says so to the window; if that came after the new
   * connection opened the folder, the window would drop the folder watch
   * the new one just asked for. Gives up after the last of `gonePoll`.
   */
  async function untilGone(ids) {
    for (const ms of gonePoll) {
      await new Promise((r) => setTimeout(r, ms));
      try {
        const live = await backend.remoteConnections();
        if (!(Array.isArray(live) ? live : []).some((c) => ids.includes(c.id))) return;
      } catch {
        return;
      }
    }
  }

  async function forget(host) {
    if (busy) return;
    hosts = removeHost(hosts, host);
    render();
    try {
      await persist();
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
