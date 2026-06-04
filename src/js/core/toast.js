// toast.js - Minimal transient notification, self-contained (injects its own styles).

let _container = null;

function ensureContainer() {
  if (_container) return _container;
  _container = document.createElement('div');
  _container.className = 'fude-toast-container';
  _container.style.cssText = [
    'position:fixed',
    'bottom:16px',
    'left:50%',
    'transform:translateX(-50%)',
    'display:flex',
    'flex-direction:column',
    'gap:8px',
    'z-index:9999',
    'pointer-events:none',
  ].join(';');
  document.body.appendChild(_container);
  return _container;
}

/**
 * Show a short transient message near the bottom of the window.
 * @param {string} message
 * @param {{ type?: 'info' | 'error', duration?: number }} [opts]
 */
export function showToast(message, opts = {}) {
  const { type = 'info', duration = 3000 } = opts;
  const el = document.createElement('div');
  el.textContent = message;
  el.style.cssText = [
    'padding:8px 14px',
    'border-radius:6px',
    'font-size:13px',
    'max-width:480px',
    'box-shadow:0 2px 8px rgba(0,0,0,0.3)',
    'opacity:0',
    'transition:opacity 0.15s ease',
    type === 'error' ? 'background:#a4262c;color:#fff' : 'background:#333;color:#fff',
  ].join(';');
  ensureContainer().appendChild(el);
  // Force reflow then fade in.
  void el.offsetHeight;
  el.style.opacity = '1';
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 200);
  }, duration);
}
