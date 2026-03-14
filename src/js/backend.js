// backend.js - Abstraction layer for Tauri commands
let invoke;

if (window.__TAURI__) {
  invoke = window.__TAURI__.core.invoke;
} else {
  invoke = async (cmd, args = {}) => {
    const res = await fetch(`http://localhost:3030/api/${cmd}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`Backend call failed: ${cmd}`);
    return res.json();
  };
}

export async function readFile(path) {
  return invoke('read_file', { path });
}

export async function writeFile(path, content) {
  return invoke('write_file', { path, content });
}

export async function writeTempFile(path, content) {
  return invoke('write_temp_file', { path, content });
}

export async function deleteTempFile(path) {
  return invoke('delete_temp_file', { path });
}

export async function checkTempFiles(paths) {
  return invoke('check_temp_files', { paths });
}

export async function readDirTree(path) {
  return invoke('read_dir_tree', { path });
}

export async function saveSession(session) {
  return invoke('save_session', { session });
}

export async function loadSession() {
  return invoke('load_session');
}

export async function getConfig() {
  return invoke('get_config');
}

export async function saveConfig(config) {
  return invoke('save_config', { config });
}
