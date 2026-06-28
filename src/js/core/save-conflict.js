// save-conflict.js - Detect and resolve "file changed on disk" at save time.
//
// Fude already watches open files and offers to reload on external changes, but
// that watcher is async and absent in browser mode. This adds a synchronous
// safety net at save time: before overwriting, we compare the current disk hash
// to the hash recorded when we last synced with disk. If they differ (and the
// disk content actually differs from the editor), we show a diff and let the
// user choose instead of silently clobbering the external edit.
import { diffLines, diffStats } from './line-diff.js';

/**
 * Decide whether saving should warn about an external change. Pure.
 *
 * @param {object} p
 * @param {string|null|undefined} p.loadedHash    hash recorded at last disk sync
 * @param {string|null|undefined} p.currentDiskHash hash of the file on disk now
 * @param {string} p.diskContent   current file content on disk
 * @param {string} p.editorContent content about to be written
 * @returns {boolean} true → show the conflict dialog
 */
export function shouldWarnConflict({ loadedHash, currentDiskHash, diskContent, editorContent }) {
  // No baseline (new/never-synced file) → nothing to conflict with.
  if (!loadedHash) return false;
  // Disk unchanged since we loaded it → normal save.
  if (currentDiskHash === loadedHash) return false;
  // Disk changed, but already equals what we're about to write → no real loss.
  if (diskContent === editorContent) return false;
  return true;
}

/**
 * Show the save-conflict dialog with a line diff (disk → editor) and let the
 * user resolve it. Exactly one callback fires.
 *
 * @param {object} p
 * @param {string} p.fileName       display name
 * @param {string} p.diskContent    current content on disk
 * @param {string} p.editorContent  content in the editor (what would be saved)
 * @param {() => void} p.onOverwrite save the editor content over the disk change
 * @param {() => void} p.onReload    discard editor changes, load the disk version
 * @param {() => void} [p.onCancel]  do nothing (leave unsaved)
 */
export function showConflictDialog({
  fileName,
  diskContent,
  editorContent,
  onOverwrite,
  onReload,
  onCancel,
}) {
  const diff = diffLines(diskContent, editorContent);
  const { added, removed } = diffStats(diff);

  const overlay = document.createElement('div');
  overlay.className = 'settings-overlay save-conflict-overlay';
  overlay.innerHTML = `
    <div class="settings-panel" style="width:680px;max-width:92vw;max-height:82vh;display:flex;flex-direction:column">
      <div class="settings-header">
        <h2>外部で変更されています</h2>
      </div>
      <div class="settings-body" style="padding:16px 20px;overflow:auto">
        <p style="margin:0 0 4px;color:var(--fg-primary)">
          "${escapeHtml(fileName)}" は開いた後にディスク上で変更されました。
        </p>
        <p style="margin:0 0 12px;color:var(--fg-secondary);font-size:13px">
          下はディスク版（赤=削除）とエディタ版（緑=追加）の差分です。
          <span style="color:var(--code-inserted,#3fb950)">+${added}</span>
          <span style="color:var(--code-deleted,#f85149)">-${removed}</span>
        </p>
        <div class="conflict-diff" style="font-family:var(--font-mono);font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word;border:1px solid var(--border);border-radius:6px;padding:8px;background:var(--preview-code-bg,#2d2d2d)"></div>
      </div>
      <div class="settings-footer" style="display:flex;gap:8px;justify-content:flex-end;padding:12px 20px;border-top:1px solid var(--border)">
        <button class="btn-cancel" style="padding:6px 16px;background:var(--bg-tertiary);color:var(--fg-primary);border:1px solid var(--border);border-radius:4px;cursor:pointer">キャンセル</button>
        <button class="btn-reload" style="padding:6px 16px;background:var(--bg-tertiary);color:var(--fg-primary);border:1px solid var(--border);border-radius:4px;cursor:pointer">ディスク版を読込（編集を破棄）</button>
        <button class="btn-overwrite" style="padding:6px 16px;background:var(--fg-accent);color:#fff;border:none;border-radius:4px;cursor:pointer">自分の変更で上書き</button>
      </div>
    </div>
  `;

  const diffEl = overlay.querySelector('.conflict-diff');
  diffEl.appendChild(renderDiff(diff));
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector('.btn-cancel').addEventListener('click', () => {
    close();
    onCancel?.();
  });
  overlay.querySelector('.btn-reload').addEventListener('click', () => {
    close();
    onReload();
  });
  overlay.querySelector('.btn-overwrite').addEventListener('click', () => {
    close();
    onOverwrite();
  });
  return overlay;
}

/**
 * Build a DOM fragment of colored diff lines. Exported for tests.
 * @param {Array<{type: string, value: string}>} diff
 * @returns {DocumentFragment}
 */
export function renderDiff(diff) {
  const frag = document.createDocumentFragment();
  for (const d of diff) {
    const line = document.createElement('div');
    const prefix = d.type === 'add' ? '+ ' : d.type === 'del' ? '- ' : '  ';
    line.textContent = prefix + d.value;
    line.className = `diff-${d.type}`;
    if (d.type === 'add') line.style.color = 'var(--code-inserted,#3fb950)';
    else if (d.type === 'del') line.style.color = 'var(--code-deleted,#f85149)';
    else line.style.color = 'var(--fg-secondary)';
    frag.appendChild(line);
  }
  return frag;
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}
