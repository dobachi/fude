// remote-view.js - the "リモート接続" view: the ssh hosts this Fude receives
// files from, WSL integration, and opening a place on either from here.
// The controls live in setup-panel.js; this is the window around them.
import * as backend from '../../backend.js';
import {
  remoteSectionHtml,
  initRemoteSection,
  initWslSection,
  createRecentStore,
} from './setup-panel.js';

let view = null;

function onKeydown(e) {
  if (e.key === 'Escape' && view) {
    e.preventDefault();
    e.stopPropagation();
    closeRemoteView();
  }
}

export function closeRemoteView() {
  if (!view) return;
  view.remove();
  view = null;
  document.removeEventListener('keydown', onKeydown, true);
}

/** Open the view (desktop app only; elsewhere there is nothing to run). */
export async function openRemoteView() {
  if (view || !backend.isLocalTauri()) return;

  let config = {};
  try {
    config = await backend.getConfig();
  } catch {
    /* an empty view still lets a host be set up */
  }
  if (view) return;

  view = document.createElement('div');
  view.className = 'settings-overlay remote-overlay';
  view.innerHTML = `
    <div class="settings-panel remote-panel" role="dialog" aria-label="リモート接続">
      <div class="settings-header">
        <h2>リモート接続</h2>
        <button class="settings-close icon-btn" title="閉じる (Esc)">\u00d7</button>
      </div>
      <div class="settings-body">${remoteSectionHtml()}</div>
    </div>`;
  document.body.appendChild(view);

  view.querySelector('.settings-close').addEventListener('click', closeRemoteView);
  view.addEventListener('mousedown', (e) => {
    if (e.target === view) closeRemoteView();
  });
  document.addEventListener('keydown', onKeydown, true);

  const recent = createRecentStore(backend, config.remote_recent);
  // What was opened appears as a tab behind this view: get out of its way.
  const opts = { recent, onOpened: closeRemoteView };
  initRemoteSection(view, backend, config.setup_hosts, opts);
  initWslSection(view, backend, undefined, opts).catch((e) =>
    console.error('WSL section failed:', e),
  );
  view.querySelector('#remote-host')?.focus();
}
