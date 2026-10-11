// setup-panel.js - "リモート接続" in the settings panel: run `fude-cli setup`
// for an ssh host from the app instead of a terminal, and keep the hosts
// that were set up so they can be re-checked or updated later.
import { hostError, addHost, removeHost } from '../../core/setup-hosts.js';

export function remoteSectionHtml() {
  return `
    <div class="setting-group setting-remote">
      <label>リモート接続 / Remote hosts</label>
      <div class="remote-add">
        <input type="text" id="remote-host" placeholder="ssh のホスト名（例: k16, user@host）" spellcheck="false" autocomplete="off" />
        <button type="button" id="remote-setup-btn">セットアップ</button>
      </div>
      <div class="remote-hosts" id="remote-hosts"></div>
      <div class="remote-status" id="remote-status" role="status"></div>
      <pre class="remote-log" id="remote-log" style="display:none"></pre>
      <small class="setting-hint">ssh で入れるホストを登録すると、そのホストで <code>fude FILE</code> と打つだけでこの Fude に開けます（<code>fude setup HOST</code> と同じ処理）。パスワード入力なしで <code>ssh HOST</code> できることが前提です。</small>
    </div>`;
}

/**
 * Wire the section inside `root`.
 * `backend` needs remoteSetup(host, checkOnly), getConfig() and saveConfig().
 */
export function initRemoteSection(root, backend, initialHosts) {
  const input = root.querySelector('#remote-host');
  const addBtn = root.querySelector('#remote-setup-btn');
  const listEl = root.querySelector('#remote-hosts');
  const statusEl = root.querySelector('#remote-status');
  const logEl = root.querySelector('#remote-log');
  if (!input || !addBtn || !listEl) return;

  let hosts = addHost(initialHosts, '');
  let busy = false;

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
