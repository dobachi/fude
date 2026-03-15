// backend.js - Abstraction layer for Tauri commands

// Lazy detection: window.__TAURI__ may not be available at module evaluation time
// (Tauri injects it via a script that may run after ES module evaluation)
function isLocalTauri() {
  return (
    window.__TAURI__ &&
    (window.location.protocol === 'tauri:' ||
      (window.location.protocol === 'https:' && window.location.hostname === 'tauri.localhost'))
  );
}

function getInvoke() {
  if (isLocalTauri()) {
    return window.__TAURI__.core.invoke;
  }
  return async (cmd, args = {}) => {
    const base = window.location.origin || 'http://localhost:3000';
    const res = await fetch(`${base}/api/${cmd}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`Backend call failed: ${cmd}`);
    return res.json();
  };
}

export async function readFile(path) {
  return getInvoke()('read_file', { path });
}

export async function writeFile(path, content) {
  return getInvoke()('write_file', { path, content });
}

export async function writeTempFile(path, content) {
  return getInvoke()('write_temp_file', { path, content });
}

export async function deleteTempFile(path) {
  return getInvoke()('delete_temp_file', { path });
}

export async function checkTempFiles(paths) {
  return getInvoke()('check_temp_files', { paths });
}

export async function readDirTree(path) {
  return getInvoke()('read_dir_tree', { path });
}

export async function saveSession(session) {
  return getInvoke()('save_session', { session });
}

export async function loadSession() {
  return getInvoke()('load_session');
}

export async function getConfig() {
  return getInvoke()('get_config');
}

export async function saveConfig(config) {
  return getInvoke()('save_config', { config });
}

export async function getOpenDir() {
  return getInvoke()('get_open_dir');
}

export async function browseDir(path) {
  return getInvoke()('browse_dir', { path: path || '' });
}

export async function aiChat(messages, model) {
  return getInvoke()('ai_chat', { messages, model });
}

export async function aiModels() {
  return getInvoke()('ai_models');
}

/**
 * Stream AI chat response.
 * Browser mode: SSE via fetch. Tauri mode: invoke + event listener.
 * @param {Array} messages
 * @param {string} model
 * @param {(chunk: string) => void} onChunk
 * @param {() => void} onDone
 * @param {(err: Error) => void} onError
 * @param {AbortSignal} [signal]
 */
export async function aiChatStream(messages, model, onChunk, onDone, onError, signal) {
  if (isLocalTauri()) {
    try {
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

      await getInvoke()('ai_chat_stream', { messages, model, requestId });
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
        buffer = lines.pop(); // Keep incomplete line in buffer

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
              // Not JSON, treat as raw text chunk
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
