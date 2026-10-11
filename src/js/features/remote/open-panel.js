// open-panel.js - the main part of the remote view (remote-view.js): open a
// folder or file on an ssh host, or inside WSL, in this window — and see and
// end the connections that are up. The app starts the far side's fude-cli
// itself and talks to it directly, so nothing has to be set up first.
import {
  hostError,
  addRecent,
  recentPaths,
  openTargets,
  pathSuggestions,
  commonPrefix,
  WSL_HOST,
} from '../../core/setup-hosts.js';

/**
 * The places opened from the view. `backend` needs getConfig() and
 * saveConfig().
 */
export function createRecentStore(backend, initial) {
  let list = addRecent(initial, '', '');
  return {
    list: () => list,
    paths: (host) => recentPaths(list, host),
    async add(host, path) {
      const next = addRecent(list, host, path);
      if (next.join('\n') === list.join('\n')) return;
      list = next;
      // Read-modify-write so settings saved elsewhere meanwhile are kept.
      const existing = await backend.getConfig();
      await backend.saveConfig({ ...existing, remote_recent: list });
    },
  };
}

export function openSectionHtml() {
  return `
    <div class="setting-group setting-remote remote-open-section">
      <p class="remote-lead">ssh で入れるホスト（または WSL）のフォルダやファイルを、この Fude で開きます。事前の設定は要りません。</p>
      <div class="remote-open-form">
        <select id="remote-target" title="接続先"></select>
        <input type="text" id="remote-target-host" placeholder="ssh のホスト名（例: k16, user@host）" spellcheck="false" autocomplete="off" style="display:none" />
        <div class="remote-path-wrap">
          <input type="text" id="remote-open-path" placeholder="フォルダ / ファイル（空欄はホーム。例: ~/notes）" spellcheck="false" autocomplete="off" role="combobox" aria-autocomplete="list" aria-controls="remote-suggest" aria-expanded="false" />
          <ul class="remote-suggest" id="remote-suggest" role="listbox" style="display:none"></ul>
        </div>
        <button type="button" id="remote-open-btn">開く</button>
      </div>
      <small class="setting-hint">パスは入力中に候補が出ます。<kbd>Tab</kbd> で補完、<kbd>↑</kbd><kbd>↓</kbd> で選択、<kbd>Enter</kbd> で開きます。以前開いた場所も候補に出ます。</small>
      <div class="remote-status" id="remote-open-status" role="status"></div>
      <pre class="remote-log" id="remote-open-log" style="display:none"></pre>
    </div>`;
}

export function connectionsHtml() {
  return `
    <div class="setting-group setting-remote remote-connections-section">
      <div class="remote-connections" id="remote-connections"></div>
      <small class="setting-hint">切断しても、開いていたタブは残ります（もう一度開くまで保存はできません）。</small>
    </div>`;
}

const OTHER = 'other';
const WSL = 'wsl';
const sshValue = (host) => `ssh:${host}`;

/**
 * Wire the open section inside `root`.
 * `backend` needs remoteOpen(host, path), wslOpen(path) and
 * remoteComplete(hostOrNull, partial). `opts`: `recent` (createRecentStore),
 * `setupHosts`, `onOpened()`, `debounce` (ms before a completion is asked
 * for), `preset` (`{ kind: 'ssh', host } | { kind: 'wsl' }` with `path`: the
 * destination and path to start on). Returns `{ setHosts, setCandidates, setWsl }` for what changes while
 * the view is open.
 */
export function initOpenSection(root, backend, opts = {}) {
  const targetEl = root.querySelector('#remote-target');
  const hostEl = root.querySelector('#remote-target-host');
  const pathEl = root.querySelector('#remote-open-path');
  const suggestEl = root.querySelector('#remote-suggest');
  const btn = root.querySelector('#remote-open-btn');
  const statusEl = root.querySelector('#remote-open-status');
  const logEl = root.querySelector('#remote-open-log');
  if (!targetEl || !pathEl || !btn) return null;

  const recent = opts.recent;
  const debounce = opts.debounce ?? 200;
  let setupHosts = opts.setupHosts || [];
  let candidates = [];
  let wslDistro = null;
  let busy = false;
  // A destination asked for from outside (the sidebar) wins over "the one
  // used last" until the user picks another.
  let preset = opts.preset && (opts.preset.kind === 'wsl' || opts.preset.host) ? opts.preset : null;

  const setStatus = (text, kind, log) => {
    statusEl.textContent = text;
    statusEl.dataset.kind = kind || '';
    logEl.textContent = log || '';
    logEl.style.display = log ? '' : 'none';
  };

  // ── destination ──────────────────────────────────────────
  /** `{ host }` for ssh, `{ host: null }` for WSL, or `{ error }`. */
  const destination = () => {
    const v = targetEl.value;
    if (v === WSL) return { host: null, key: WSL_HOST, label: 'WSL' };
    const host = v === OTHER ? hostEl.value.trim() : v.replace(/^ssh:/, '');
    const error = hostError(host);
    return error ? { error } : { host, key: host, label: host };
  };

  const renderTargets = () => {
    const before = targetEl.value;
    targetEl.textContent = '';
    const add = (value, label) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      targetEl.appendChild(opt);
    };
    const hosts = openTargets(recent ? recent.list() : [], setupHosts, candidates);
    if (preset?.kind === 'ssh' && !hosts.includes(preset.host)) hosts.unshift(preset.host);
    for (const h of hosts) add(sshValue(h), h);
    if (wslDistro) add(WSL, `WSL（${wslDistro}）`);
    add(OTHER, '別のホストを入力…');
    const values = [...targetEl.options].map((o) => o.value);
    const asked = preset ? (preset.kind === 'wsl' ? WSL : sshValue(preset.host)) : null;
    if (asked && values.includes(asked)) {
      targetEl.value = asked;
      if (typeof preset.path === 'string' && !pathEl.value) pathEl.value = preset.path;
    } else if (values.includes(before)) {
      targetEl.value = before;
    } else {
      // The destination used last, else the first there is.
      const last = recent ? recent.list()[0] : null;
      const lastHost = last ? last.split('\t')[0] : null;
      const want =
        lastHost === WSL_HOST && wslDistro ? WSL : lastHost ? sshValue(lastHost) : values[0];
      targetEl.value = values.includes(want) ? want : values[0];
    }
    onTargetChange(false);
  };

  function onTargetChange(clearPath) {
    hostEl.style.display = targetEl.value === OTHER ? '' : 'none';
    const dest = destination();
    if (clearPath) pathEl.value = '';
    // The place opened there last is the likeliest to be wanted again.
    if (!pathEl.value && !dest.error && recent) pathEl.value = recent.paths(dest.key)[0] || '';
    closeSuggest();
  }

  // ── path completion ──────────────────────────────────────
  let items = [];
  let active = -1;
  let asked = 0;
  let timer = null;

  function closeSuggest() {
    items = [];
    active = -1;
    suggestEl.textContent = '';
    suggestEl.style.display = 'none';
    pathEl.setAttribute('aria-expanded', 'false');
  }

  const renderSuggest = () => {
    suggestEl.textContent = '';
    items.forEach((text, i) => {
      const li = document.createElement('li');
      li.textContent = text;
      li.setAttribute('role', 'option');
      li.dataset.index = String(i);
      if (i === active) li.className = 'active';
      // mousedown, not click: the field must not lose focus first.
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        accept(i);
      });
      suggestEl.appendChild(li);
    });
    const open = items.length > 0;
    suggestEl.style.display = open ? '' : 'none';
    pathEl.setAttribute('aria-expanded', open ? 'true' : 'false');
    suggestEl.querySelector('.active')?.scrollIntoView?.({ block: 'nearest' });
  };

  /** Ask the far side what the typed path could become, and show it. */
  async function suggest() {
    const dest = destination();
    if (dest.error) {
      closeSuggest();
      return;
    }
    const typed = pathEl.value;
    const mine = ++asked;
    let completions = [];
    try {
      completions = (await backend.remoteComplete(dest.host, typed)) || [];
    } catch {
      /* completion is a convenience: without it the recent places remain */
    }
    // A later keystroke, or a field that moved on, makes this answer stale.
    if (mine !== asked || pathEl.value !== typed) return;
    items = pathSuggestions(typed, recent ? recent.paths(dest.key) : [], completions);
    active = -1;
    renderSuggest();
  }

  const scheduleSuggest = () => {
    clearTimeout(timer);
    if (debounce <= 0) {
      suggest();
      return;
    }
    timer = setTimeout(suggest, debounce);
  };

  function accept(i) {
    const text = items[i];
    if (text == null) return;
    pathEl.value = text;
    closeSuggest();
    pathEl.focus();
    // A directory invites the next level.
    if (text.endsWith('/')) scheduleSuggest();
  }

  pathEl.addEventListener('input', scheduleSuggest);
  pathEl.addEventListener('focus', () => {
    if (!items.length) scheduleSuggest();
  });
  pathEl.addEventListener('blur', () => {
    clearTimeout(timer);
    asked++;
    closeSuggest();
  });
  pathEl.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!items.length) return;
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      active = (active + step + items.length + (active < 0 && step < 0 ? 1 : 0)) % items.length;
      renderSuggest();
    } else if (e.key === 'Tab' && !e.shiftKey) {
      if (!items.length) return; // let Tab move on
      e.preventDefault();
      if (active >= 0) {
        accept(active);
        return;
      }
      // Like a shell: as far as the candidates agree, else the first.
      const prefix = commonPrefix(items);
      if (prefix.length > pathEl.value.length) {
        pathEl.value = prefix;
        scheduleSuggest();
      } else {
        accept(0);
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active >= 0) accept(active);
      else open();
    } else if (e.key === 'Escape' && items.length) {
      // Only the list closes; the view stays.
      e.preventDefault();
      e.stopPropagation();
      asked++;
      closeSuggest();
    }
  });

  // ── open ─────────────────────────────────────────────────
  const setBusy = (b) => {
    busy = b;
    for (const el of [btn, targetEl, hostEl, pathEl]) el.disabled = b;
  };

  async function open() {
    if (busy) return;
    const dest = destination();
    if (dest.error) {
      setStatus(dest.error, 'error');
      return;
    }
    const path = pathEl.value.trim() || '~';
    clearTimeout(timer);
    asked++;
    closeSuggest();
    setBusy(true);
    setStatus(`${dest.label}: ${path} を開いています…`, 'busy');
    let opened = false;
    try {
      const res =
        dest.host === null
          ? await backend.wslOpen(path)
          : await backend.remoteOpen(dest.host, path);
      if (res?.ok) {
        opened = true;
        setStatus(`${dest.label}: ${path} を開きました`, 'ok');
        if (recent) await recent.add(dest.key, path);
      } else {
        setStatus(`${dest.label}: ${path} を開けませんでした`, 'error', res?.log || '');
      }
    } catch (e) {
      setStatus(`${dest.label}: ${e?.message || e}`, 'error');
    } finally {
      setBusy(false);
    }
    if (opened) {
      renderTargets();
      opts.onOpened?.();
    }
  }

  btn.addEventListener('click', open);
  targetEl.addEventListener('change', () => {
    preset = null;
    onTargetChange(true);
    if (targetEl.value === OTHER) hostEl.focus();
  });
  hostEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      pathEl.focus();
    }
  });

  renderTargets();
  return {
    setHosts(hosts) {
      setupHosts = hosts || [];
      renderTargets();
    },
    setCandidates(names) {
      candidates = Array.isArray(names) ? names : [];
      renderTargets();
    },
    setWsl(status) {
      const distro = status?.supported !== false && status?.distro ? status.distro : null;
      if (distro === wslDistro) return;
      wslDistro = distro;
      renderTargets();
    },
  };
}

/** `roots` of a connection as one readable line. */
export function rootsText(roots) {
  const list = (Array.isArray(roots) ? roots : []).filter((r) => typeof r === 'string' && r);
  return list.length ? list.join('、') : '（場所は不明）';
}

/**
 * Show the connections that are up inside `root`, each with a way to end
 * it. `backend` needs remoteConnections() and remoteDisconnect(id).
 * `opts.interval` is how often the list is re-read, in ms (0: only on
 * request). Returns `{ refresh, stop }`.
 */
export function initConnections(root, backend, opts = {}) {
  const listEl = root.querySelector('#remote-connections');
  if (!listEl) return null;
  const interval = opts.interval ?? 2000;
  let shown = null;
  let stopped = false;

  const render = (conns) => {
    const key = JSON.stringify(conns);
    if (key === shown) return; // nothing moved: keep focus and hover as they are
    shown = key;
    listEl.textContent = '';
    if (!conns.length) {
      const none = document.createElement('div');
      none.className = 'remote-connections-none';
      none.textContent = '接続中のリモートはありません';
      listEl.appendChild(none);
      return;
    }
    for (const c of conns) {
      const row = document.createElement('div');
      row.className = 'remote-connection-row';
      row.dataset.id = String(c.id);
      const host = document.createElement('span');
      host.className = 'remote-host-name';
      host.textContent = c.host;
      const where = document.createElement('span');
      where.className = 'remote-connection-roots';
      where.textContent = rootsText(c.roots);
      where.title = where.textContent;
      const off = document.createElement('button');
      off.type = 'button';
      off.className = 'remote-disconnect';
      off.textContent = '切断';
      off.title = 'この接続を切る（タブは残ります）';
      off.addEventListener('click', async () => {
        off.disabled = true;
        try {
          await backend.remoteDisconnect(c.id);
        } catch {
          /* gone already: the refresh shows it */
        }
        await refresh();
      });
      row.append(host, where, off);
      listEl.appendChild(row);
    }
  };

  async function refresh() {
    try {
      const conns = await backend.remoteConnections();
      if (!stopped) render(Array.isArray(conns) ? conns : []);
    } catch {
      /* keep what is shown */
    }
  }

  let handle = null;
  if (interval > 0) {
    handle = setInterval(() => {
      // A view that was closed stops asking.
      if (stopped || !listEl.isConnected) {
        clearInterval(handle);
        return;
      }
      refresh();
    }, interval);
  }
  refresh();
  return {
    refresh,
    stop() {
      stopped = true;
      if (handle) clearInterval(handle);
    },
  };
}
