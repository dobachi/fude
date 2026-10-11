// remote-view.js - the "リモート接続" view. Three parts, in the order they
// are needed: open a place on another machine (open-panel.js), the
// connections that are up, and — folded away, optional — what makes
// `fude FILE` typed on a host reach this window (setup-panel.js).
import * as backend from '../../backend.js';
import { remoteSectionHtml, initRemoteSection, initWslSection } from './setup-panel.js';
import {
  openSectionHtml,
  connectionsHtml,
  initOpenSection,
  initConnections,
  createRecentStore,
} from './open-panel.js';

let view = null;
let connections = null;

function onKeydown(e) {
  if (e.key === 'Escape' && view) {
    e.preventDefault();
    e.stopPropagation();
    closeRemoteView();
  }
}

export function closeRemoteView() {
  if (!view) return;
  connections?.stop();
  connections = null;
  view.remove();
  view = null;
  document.removeEventListener('keydown', onKeydown);
}

/**
 * Build the view over `api` (the backend) and put it in the document.
 * Separate from openRemoteView so the layout can be shown with a stand-in
 * backend.
 */
export function mountRemoteView(api, config, onClose, preset = null) {
  const el = document.createElement('div');
  el.className = 'settings-overlay remote-overlay';
  el.innerHTML = `
    <div class="settings-panel remote-panel" role="dialog" aria-label="リモート接続">
      <div class="settings-header">
        <h2>リモート接続</h2>
        <button class="settings-close icon-btn" title="閉じる (Esc)">\u00d7</button>
      </div>
      <div class="settings-body">
        <h3 class="remote-heading">開く</h3>
        ${openSectionHtml()}
        <h3 class="remote-heading">接続中</h3>
        ${connectionsHtml()}
        <details class="remote-optional" id="remote-optional">
          <summary>ホストの端末から開けるようにする（任意の設定）</summary>
          ${remoteSectionHtml()}
        </details>
      </div>
    </div>`;
  document.body.appendChild(el);

  el.querySelector('.settings-close').addEventListener('click', onClose);
  el.addEventListener('mousedown', (e) => {
    if (e.target === el) onClose();
  });

  const recent = createRecentStore(api, config.remote_recent);
  const open = initOpenSection(el, api, {
    recent,
    setupHosts: config.setup_hosts,
    preset,
    // What was opened appears as a tab behind this view: get out of its way.
    onOpened: onClose,
  });
  const conns = initConnections(el, api);
  initRemoteSection(el, api, config.setup_hosts, { onHosts: (h) => open?.setHosts(h) });
  initWslSection(el, api, undefined, { onChange: (st) => open?.setWsl(st) }).catch((e) =>
    console.error('WSL section failed:', e),
  );
  api
    .sshHostCandidates()
    .then((names) => open?.setCandidates(names))
    .catch(() => {});
  el.querySelector('#remote-open-path')?.focus();
  return { el, conns };
}

/**
 * Open the view (desktop app only; elsewhere there is nothing to run).
 * `preset` (`{ kind: 'ssh', host } | { kind: 'wsl' }`, plus `path`) starts
 * it on that destination — for opening another place on the machine whose
 * folder is shown.
 */
export async function openRemoteView(preset = null) {
  if (view || !backend.isLocalTauri()) return;

  let config = {};
  try {
    config = await backend.getConfig();
  } catch {
    /* an empty view still lets a place be opened */
  }
  if (view) return;

  const mounted = mountRemoteView(backend, config, closeRemoteView, preset);
  view = mounted.el;
  connections = mounted.conns;
  // Bubble phase: the path field closes its own list on Escape first.
  document.addEventListener('keydown', onKeydown);
}
