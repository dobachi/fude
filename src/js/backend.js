// backend.js - Abstraction layer for Tauri commands
//
// Detection strategy:
// The URL protocol is the most reliable way to detect Tauri on all platforms:
// - tauri: protocol (Linux/macOS) or https://tauri.localhost (Windows)
// When in a Tauri webview, use __TAURI_INTERNALS__.invoke directly.
// If __TAURI_INTERNALS__ is not yet available (Windows timing issue tauri#12990),
// wait briefly for it to become available before falling back to HTTP.

// Detect Tauri webview by URL protocol (reliable, no runtime dependency)
function isTauriWebview() {
  return (
    window.location.protocol === 'tauri:' ||
    window.location.hostname === 'tauri.localhost'
  );
}

// Wait for __TAURI_INTERNALS__ to become available (handles Windows timing issue)
let _internalsReady = null;
function waitForInternals() {
  if (_internalsReady) return _internalsReady;
  _internalsReady = new Promise((resolve) => {
    if (window.__TAURI_INTERNALS__) {
      resolve(window.__TAURI_INTERNALS__);
      return;
    }
    // Poll briefly for the runtime to inject __TAURI_INTERNALS__
    let attempts = 0;
    const interval = setInterval(() => {
      attempts++;
      if (window.__TAURI_INTERNALS__) {
        clearInterval(interval);
        resolve(window.__TAURI_INTERNALS__);
      } else if (attempts >= 50) { // 500ms max
        clearInterval(interval);
        resolve(null);
      }
    }, 10);
  });
  return _internalsReady;
}

async function doInvoke(cmd, args) {
  if (isTauriWebview()) {
    const internals = await waitForInternals();
    if (internals?.invoke) {
      return args !== undefined ? internals.invoke(cmd, args) : internals.invoke(cmd);
    }
    // __TAURI_INTERNALS__ not available even after waiting — should not happen
    console.error('Tauri webview detected but __TAURI_INTERNALS__ not available');
  }
  // HTTP fallback for browser mode
  const base = window.location.origin || 'http://localhost:3000';
  const res = await fetch(`${base}/api/${cmd}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args || {}),
  });
  if (!res.ok) throw new Error(`Backend call failed: ${cmd}`);
  return res.json();
}

// Export isTauriWebview for use in app.js
export { isTauriWebview as isLocalTauri };

export async function readFile(path) {
  return doInvoke('read_file', { path });
}

export async function writeFile(path, content) {
  return doInvoke('write_file', { path, content });
}

export async function writeTempFile(path, content) {
  return doInvoke('write_temp_file', { path, content });
}

export async function deleteTempFile(path) {
  return doInvoke('delete_temp_file', { path });
}

export async function checkTempFiles(paths) {
  return doInvoke('check_temp_files', { paths });
}

export async function readDirTree(path, showAllFiles) {
  return doInvoke('read_dir_tree', { path, show_all_files: showAllFiles || false });
}

export async function saveSession(session) {
  return doInvoke('save_session', { session });
}

export async function loadSession() {
  return doInvoke('load_session');
}

export async function getConfig() {
  return doInvoke('get_config');
}

export async function saveConfig(config) {
  return doInvoke('save_config', { config });
}

export async function setApiKey(key) {
  return doInvoke('set_api_key', { key });
}

export async function deleteApiKey() {
  return doInvoke('delete_api_key');
}

export async function getOpenDir() {
  return doInvoke('get_open_dir');
}

export async function browseDir(path) {
  return doInvoke('browse_dir', { path: path || '' });
}

export async function aiChat(messages, model) {
  return doInvoke('ai_chat', { messages, model });
}

export async function aiModels() {
  return doInvoke('ai_models');
}

/**
 * Stream AI chat response.
 * Browser mode: SSE via fetch. Tauri mode: invoke + event listener.
 */
export async function aiChatStream(messages, model, onChunk, onDone, onError, signal) {
  if (isTauriWebview()) {
    try {
      const internals = await waitForInternals();
      if (!internals?.invoke) throw new Error('Tauri IPC not available');

      const { listen } = await import('@tauri-apps/api/event');
      const requestId = `ai_${Date.now()}_${Math.random().toString(36).slice(2)}`;

      const unlisten = await listen(`ai-stream-${requestId}`, (event) => {
        const { type, data } = event.payload;
        if (type === 'chunk') onChunk(data);
        else if (type === 'done') { unlisten(); onDone(); }
        else if (type === 'error') { unlisten(); onError(new Error(data)); }
      });

      if (signal) {
        signal.addEventListener('abort', () => { unlisten(); });
      }

      await internals.invoke('ai_chat_stream', { messages, model, requestId });
    } catch (err) {
      onError(err);
    }
  } else {
    // Browser mode: SSE via fetch
    const base = window.location.origin || 'http://localhost:3000';
    try {
      const res = await fetch(`${base}/api/ai_chat_stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, model }),
        signal,
      });

      if (!res.ok) {
        const text = await res.text();
        onError(new Error(`AI request failed: ${text}`));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              onDone();
              return;
            }
            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices?.[0]?.delta?.content;
              if (content) onChunk(content);
            } catch {
              if (data) onChunk(data);
            }
          }
        }
      }
      onDone();
    } catch (err) {
      if (err.name !== 'AbortError') onError(err);
    }
  }
}
