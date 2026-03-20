mod key_storage;

use futures_util::StreamExt;
use key_storage::{create_storage, set_dir_permissions, set_file_permissions, KeyStorage};
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_cli::CliExt;

static KEY_STORAGE: OnceLock<Box<dyn KeyStorage>> = OnceLock::new();

// ─── Structs ───────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Option<Vec<FileEntry>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TabInfo {
    pub path: String,
    pub cursor_line: usize,
    pub cursor_col: usize,
    pub scroll_top: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaneInfo {
    pub tab_id: Option<String>,
    pub size_percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaneLayout {
    pub direction: String,
    pub panes: Vec<PaneInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub open_tabs: Vec<TabInfo>,
    pub active_tab: usize,
    pub vault_path: Option<String>,
    pub view_mode: String,
    pub sidebar_visible: bool,
    pub pane_layout: Option<PaneLayout>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Features {
    pub ai_copilot: bool,
    pub diff_highlight: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub theme: String,
    pub features: Features,
    pub font_size: u32,
    pub vim_mode: bool,
    pub openrouter_api_key: Option<String>,
    pub ai_model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigResponse {
    pub theme: String,
    pub features: Features,
    pub font_size: u32,
    pub vim_mode: bool,
    pub has_api_key: bool,
    pub api_key_storage: String,
    pub ai_model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TempFileInfo {
    pub original_path: String,
    pub temp_path: String,
    pub modified: String,
}

// ─── Helpers ───────────────────────────────────────────────

fn get_key_storage() -> &'static dyn KeyStorage {
    KEY_STORAGE
        .get()
        .expect("Key storage not initialized")
        .as_ref()
}

fn init_key_storage() {
    let config_path = config_dir()
        .map(|d| d.join("config.json"))
        .unwrap_or_else(|_| PathBuf::from("config.json"));
    let _ = KEY_STORAGE.set(create_storage(config_path));
}

fn get_api_key() -> Result<Option<String>, String> {
    get_key_storage().get_key()
}

fn config_dir() -> Result<PathBuf, String> {
    let base =
        dirs::config_dir().ok_or_else(|| "Could not determine config directory".to_string())?;
    Ok(base.join("fude"))
}

fn ensure_config_dir() -> Result<PathBuf, String> {
    let dir = config_dir()?;
    if !dir.exists() {
        fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create config directory: {}", e))?;
    }
    Ok(dir)
}

fn temp_dir() -> Result<PathBuf, String> {
    let dir = config_dir()?.join("tmp");
    if !dir.exists() {
        fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create temp directory: {}", e))?;
    }
    Ok(dir)
}

fn temp_file_path(original_path: &str) -> Result<PathBuf, String> {
    let dir = temp_dir()?;
    let mut hasher = DefaultHasher::new();
    original_path.hash(&mut hasher);
    let hash = hasher.finish();
    let file_name = Path::new(original_path)
        .file_name()
        .ok_or_else(|| "Invalid file path".to_string())?
        .to_string_lossy();
    let temp_name = format!("{:x}_{}", hash, file_name);
    Ok(dir.join(temp_name))
}

impl Default for Config {
    fn default() -> Self {
        Config {
            theme: "dark".to_string(),
            features: Features {
                ai_copilot: false,
                diff_highlight: true,
            },
            font_size: 14,
            vim_mode: false,
            openrouter_api_key: None,
            ai_model: None,
        }
    }
}

impl Default for Features {
    fn default() -> Self {
        Features {
            ai_copilot: false,
            diff_highlight: true,
        }
    }
}

impl Default for Session {
    fn default() -> Self {
        Session {
            open_tabs: Vec::new(),
            active_tab: 0,
            vault_path: None,
            view_mode: "split".to_string(),
            sidebar_visible: true,
            pane_layout: None,
        }
    }
}

fn migrate_api_key() {
    let config_path = match config_dir() {
        Ok(d) => d.join("config.json"),
        Err(_) => return,
    };
    if !config_path.exists() {
        return;
    }

    // Read config and check for plaintext key
    let content = match fs::read_to_string(&config_path) {
        Ok(c) => c,
        Err(_) => return,
    };
    let config: Config = match serde_json::from_str(&content) {
        Ok(c) => c,
        Err(_) => return,
    };

    let key = match &config.openrouter_api_key {
        Some(k) if !k.is_empty() => k.clone(),
        _ => return,
    };

    let storage = get_key_storage();

    // Only migrate if using keychain (no point migrating to itself)
    if storage.storage_type() != "keychain" {
        // Still strengthen permissions on the file
        let _ = set_file_permissions(&config_path);
        if let Some(parent) = config_path.parent() {
            let _ = set_dir_permissions(parent);
        }
        return;
    }

    // Try to store in keyring
    if storage.set_key(&key).is_ok() {
        // Remove key from config.json
        let mut config_clean = config;
        config_clean.openrouter_api_key = None;
        if let Ok(new_content) = serde_json::to_string_pretty(&config_clean) {
            let _ = fs::write(&config_path, new_content);
        }
        eprintln!("Migrated API key from config.json to OS keychain");
    }

    let _ = set_file_permissions(&config_path);
    if let Some(parent) = config_path.parent() {
        let _ = set_dir_permissions(parent);
    }
}

fn scan_dir_tree(dir: &Path) -> Result<Vec<FileEntry>, String> {
    let mut entries = Vec::new();

    let read_dir = fs::read_dir(dir)
        .map_err(|e| format!("Failed to read directory '{}': {}", dir.display(), e))?;

    let mut items: Vec<_> = read_dir.filter_map(|entry| entry.ok()).collect();

    items.sort_by(|a, b| {
        let a_is_dir = a.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
        let b_is_dir = b.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
        match (a_is_dir, b_is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.file_name().cmp(&b.file_name()),
        }
    });

    for item in items {
        let name = item.file_name().to_string_lossy().to_string();
        let path = item.path();

        // Skip hidden files and directories
        if name.starts_with('.') {
            continue;
        }

        let is_dir = item.file_type().map(|ft| ft.is_dir()).unwrap_or(false);

        if is_dir {
            let children = scan_dir_tree(&path)?;
            // Only include directories that contain .md files (directly or nested)
            if !children.is_empty() {
                entries.push(FileEntry {
                    name,
                    path: path.to_string_lossy().to_string(),
                    is_dir: true,
                    children: Some(children),
                });
            }
        } else if name.ends_with(".md") {
            entries.push(FileEntry {
                name,
                path: path.to_string_lossy().to_string(),
                is_dir: false,
                children: None,
            });
        }
    }

    Ok(entries)
}

// ─── Tauri Commands ────────────────────────────────────────

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("Failed to read file '{}': {}", path, e))
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    let file_path = Path::new(&path);
    if let Some(parent) = file_path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| {
                format!("Failed to create parent directories for '{}': {}", path, e)
            })?;
        }
    }
    fs::write(&path, content).map_err(|e| format!("Failed to write file '{}': {}", path, e))
}

#[tauri::command]
fn read_dir_tree(path: String) -> Result<Vec<FileEntry>, String> {
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("'{}' is not a directory", path));
    }
    scan_dir_tree(dir)
}

#[tauri::command]
fn load_session() -> Result<Option<Session>, String> {
    let path = config_dir()?.join("session.json");
    if !path.exists() {
        return Ok(None);
    }
    let content =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read session file: {}", e))?;
    let session: Session = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse session file: {}", e))?;
    Ok(Some(session))
}

#[tauri::command]
fn save_session(session: Session) -> Result<(), String> {
    let dir = ensure_config_dir()?;
    let path = dir.join("session.json");
    let content = serde_json::to_string_pretty(&session)
        .map_err(|e| format!("Failed to serialize session: {}", e))?;
    fs::write(&path, content).map_err(|e| format!("Failed to write session file: {}", e))
}

fn load_config() -> Result<Config, String> {
    let path = config_dir()?.join("config.json");
    if !path.exists() {
        return Ok(Config::default());
    }
    let content =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read config file: {}", e))?;
    let config: Config = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse config file: {}", e))?;
    Ok(config)
}

#[tauri::command]
fn get_config() -> Result<ConfigResponse, String> {
    let config = load_config()?;
    let storage = get_key_storage();
    let has_api_key = storage.get_key()?.is_some();
    Ok(ConfigResponse {
        theme: config.theme,
        features: config.features,
        font_size: config.font_size,
        vim_mode: config.vim_mode,
        has_api_key,
        api_key_storage: storage.storage_type().to_string(),
        ai_model: config.ai_model,
    })
}

#[tauri::command]
fn save_config(config: Config) -> Result<(), String> {
    let dir = ensure_config_dir()?;
    let path = dir.join("config.json");

    // If an API key is provided, store it in key storage
    let mut config_to_save = config;
    if let Some(ref key) = config_to_save.openrouter_api_key {
        if !key.is_empty() {
            let storage = get_key_storage();
            storage.set_key(key)?;
            // If keyring succeeded, don't store in config file
            if storage.storage_type() == "keychain" {
                config_to_save.openrouter_api_key = None;
            }
        }
    }

    let content = serde_json::to_string_pretty(&config_to_save)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    fs::write(&path, &content).map_err(|e| format!("Failed to write config file: {}", e))?;

    // Strengthen file permissions
    let _ = set_file_permissions(&path);
    let _ = set_dir_permissions(&dir);

    Ok(())
}

#[tauri::command]
fn write_temp_file(path: String, content: String) -> Result<(), String> {
    let temp_path = temp_file_path(&path)?;
    fs::write(&temp_path, content)
        .map_err(|e| format!("Failed to write temp file '{}': {}", temp_path.display(), e))
}

#[tauri::command]
fn delete_temp_file(path: String) -> Result<(), String> {
    let temp_path = temp_file_path(&path)?;
    if temp_path.exists() {
        fs::remove_file(&temp_path).map_err(|e| {
            format!(
                "Failed to delete temp file '{}': {}",
                temp_path.display(),
                e
            )
        })?;
    }
    Ok(())
}

#[tauri::command]
fn check_temp_files(paths: Vec<String>) -> Result<Vec<TempFileInfo>, String> {
    let mut results = Vec::new();

    for path in paths {
        let temp_path = match temp_file_path(&path) {
            Ok(p) => p,
            Err(_) => continue,
        };

        if temp_path.exists() {
            let metadata = fs::metadata(&temp_path)
                .map_err(|e| format!("Failed to read temp file metadata: {}", e))?;
            let modified = metadata
                .modified()
                .map(|t| {
                    let duration = t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
                    format!("{}", duration.as_millis())
                })
                .unwrap_or_else(|_| "unknown".to_string());

            results.push(TempFileInfo {
                original_path: path,
                temp_path: temp_path.to_string_lossy().to_string(),
                modified,
            });
        }
    }

    Ok(results)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowseEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowseResult {
    pub current: String,
    pub parent: String,
    pub entries: Vec<BrowseEntry>,
}

fn list_directory(dir: &Path) -> Result<Vec<BrowseEntry>, String> {
    let read_dir = fs::read_dir(dir)
        .map_err(|e| format!("Failed to read directory '{}': {}", dir.display(), e))?;

    let mut entries: Vec<BrowseEntry> = Vec::new();
    for item in read_dir.filter_map(|e| e.ok()) {
        let name = item.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let is_dir = item.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
        entries.push(BrowseEntry {
            name,
            path: item.path().to_string_lossy().to_string(),
            is_dir,
        });
    }

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

#[tauri::command]
fn browse_dir(path: String) -> Result<BrowseResult, String> {
    let dir = if path.is_empty() {
        dirs::home_dir().ok_or_else(|| "Could not determine home directory".to_string())?
    } else {
        PathBuf::from(&path)
    };

    if !dir.is_dir() {
        return Err(format!("'{}' is not a directory", dir.display()));
    }

    let parent = dir
        .parent()
        .unwrap_or(&dir)
        .to_string_lossy()
        .to_string();

    let entries = list_directory(&dir)?;

    Ok(BrowseResult {
        current: dir.to_string_lossy().to_string(),
        parent,
        entries,
    })
}

#[tauri::command]
fn set_api_key(key: String) -> Result<String, String> {
    let storage = get_key_storage();
    storage.set_key(&key)?;

    // If using keychain, clear the key from config.json
    if storage.storage_type() == "keychain" {
        let path = config_dir()?.join("config.json");
        if path.exists() {
            let content = fs::read_to_string(&path)
                .map_err(|e| format!("Failed to read config: {}", e))?;
            let mut value: serde_json::Value = serde_json::from_str(&content)
                .map_err(|e| format!("Failed to parse config: {}", e))?;
            value["openrouter_api_key"] = serde_json::Value::Null;
            let content = serde_json::to_string_pretty(&value)
                .map_err(|e| format!("Failed to serialize config: {}", e))?;
            fs::write(&path, content)
                .map_err(|e| format!("Failed to write config: {}", e))?;
            let _ = set_file_permissions(&path);
        }
    }

    Ok(storage.storage_type().to_string())
}

#[tauri::command]
fn delete_api_key() -> Result<(), String> {
    let storage = get_key_storage();
    storage.delete_key()?;

    // Also clear from config.json
    let path = config_dir()?.join("config.json");
    if path.exists() {
        let content = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read config: {}", e))?;
        let mut value: serde_json::Value = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse config: {}", e))?;
        value["openrouter_api_key"] = serde_json::Value::Null;
        let content = serde_json::to_string_pretty(&value)
            .map_err(|e| format!("Failed to serialize config: {}", e))?;
        fs::write(&path, content)
            .map_err(|e| format!("Failed to write config: {}", e))?;
    }

    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AiStreamEvent {
    #[serde(rename = "type")]
    event_type: String,
    data: String,
}

#[tauri::command]
async fn ai_chat(messages: Vec<ChatMessage>, model: String) -> Result<String, String> {
    let api_key = get_api_key()?
        .ok_or_else(|| "OpenRouter API key not configured".to_string())?;

    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "model": if model.is_empty() { "openai/gpt-4o-mini".to_string() } else { model },
        "messages": messages,
    });

    let resp = client
        .post("https://openrouter.ai/api/v1/chat/completions")
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let text = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    Ok(text)
}

#[tauri::command]
async fn ai_chat_stream(
    app: tauri::AppHandle,
    messages: Vec<ChatMessage>,
    model: String,
    request_id: String,
) -> Result<(), String> {
    let api_key = get_api_key()?
        .ok_or_else(|| "OpenRouter API key not configured".to_string())?;

    let event_name = format!("ai-stream-{}", request_id);
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "model": if model.is_empty() { "openai/gpt-4o-mini".to_string() } else { model },
        "messages": messages,
        "stream": true,
    });

    let resp = client
        .post("https://openrouter.ai/api/v1/chat/completions")
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !resp.status().is_success() {
        let error_text = resp
            .text()
            .await
            .unwrap_or_else(|_| "Unknown error".to_string());
        let _ = app.emit(
            &event_name,
            AiStreamEvent {
                event_type: "error".to_string(),
                data: error_text,
            },
        );
        return Ok(());
    }

    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(bytes) => {
                buffer.push_str(&String::from_utf8_lossy(&bytes));

                // Process complete SSE lines
                while let Some(newline_pos) = buffer.find('\n') {
                    let line = buffer[..newline_pos].trim().to_string();
                    buffer = buffer[newline_pos + 1..].to_string();

                    if line.starts_with("data: ") {
                        let data = &line[6..];
                        if data == "[DONE]" {
                            let _ = app.emit(
                                &event_name,
                                AiStreamEvent {
                                    event_type: "done".to_string(),
                                    data: String::new(),
                                },
                            );
                            return Ok(());
                        }

                        if let Ok(parsed) =
                            serde_json::from_str::<serde_json::Value>(data)
                        {
                            if let Some(content) = parsed["choices"][0]["delta"]["content"]
                                .as_str()
                            {
                                let _ = app.emit(
                                    &event_name,
                                    AiStreamEvent {
                                        event_type: "chunk".to_string(),
                                        data: content.to_string(),
                                    },
                                );
                            }
                        }
                    }
                }
            }
            Err(e) => {
                let _ = app.emit(
                    &event_name,
                    AiStreamEvent {
                        event_type: "error".to_string(),
                        data: format!("Stream error: {}", e),
                    },
                );
                return Ok(());
            }
        }
    }

    let _ = app.emit(
        &event_name,
        AiStreamEvent {
            event_type: "done".to_string(),
            data: String::new(),
        },
    );

    Ok(())
}

#[tauri::command]
async fn ai_models() -> Result<serde_json::Value, String> {
    let api_key = match get_api_key()? {
        Some(key) if !key.is_empty() => key,
        _ => return Ok(serde_json::json!({ "data": [] })),
    };

    let client = reqwest::Client::new();
    let resp = client
        .get("https://openrouter.ai/api/v1/models")
        .header("Authorization", format!("Bearer {}", api_key))
        .send()
        .await
        .map_err(|e| format!("Failed to fetch models: {}", e))?;

    let body = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    serde_json::from_str(&body).map_err(|e| format!("Failed to parse models: {}", e))
}

#[tauri::command]
fn get_open_dir() -> Result<String, String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not determine home directory".to_string())?;
    Ok(home.to_string_lossy().to_string())
}

// ─── App Entry ─────────────────────────────────────────────

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_cli::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            read_dir_tree,
            load_session,
            save_session,
            get_config,
            save_config,
            set_api_key,
            delete_api_key,
            write_temp_file,
            delete_temp_file,
            check_temp_files,
            browse_dir,
            get_open_dir,
            ai_chat,
            ai_chat_stream,
            ai_models,
        ])
        .setup(|app| {
            // Initialize key storage
            init_key_storage();

            // Migrate plaintext API key from config.json to keyring
            migrate_api_key();

            let handle = app.handle().clone();
            if let Ok(matches) = app.cli().matches() {
                let mut cli_path: Option<String> = None;
                let mut cli_remote: Option<String> = None;

                if let Some(arg) = matches.args.get("path") {
                    if let Some(val) = arg.value.as_str() {
                        let s = val.to_string();
                        if !s.is_empty() {
                            cli_path = Some(s);
                        }
                    }
                }

                if let Some(arg) = matches.args.get("remote") {
                    if let Some(val) = arg.value.as_str() {
                        let s = val.to_string();
                        if !s.is_empty() {
                            cli_remote = Some(s);
                        }
                    }
                }

                if let Some(remote_url) = cli_remote {
                    let window = app.get_webview_window("main").unwrap();
                    let _ = window.navigate(remote_url.parse().unwrap());
                } else if let Some(path) = cli_path {
                    let payload = serde_json::json!({ "path": path });
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(500));
                        let _ = handle.emit("cli-args", payload);
                    });
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ─── Tests ────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    // --- scan_dir_tree tests ---

    #[test]
    fn scan_dir_tree_finds_md_files() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("note.md"), "# Hello").unwrap();
        fs::write(tmp.path().join("readme.txt"), "ignored").unwrap();

        let entries = scan_dir_tree(tmp.path()).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "note.md");
        assert!(!entries[0].is_dir);
        assert!(entries[0].children.is_none());
    }

    #[test]
    fn scan_dir_tree_recurses_into_subdirs() {
        let tmp = TempDir::new().unwrap();
        let sub = tmp.path().join("docs");
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join("guide.md"), "content").unwrap();

        let entries = scan_dir_tree(tmp.path()).unwrap();
        assert_eq!(entries.len(), 1);
        assert!(entries[0].is_dir);
        assert_eq!(entries[0].name, "docs");
        let children = entries[0].children.as_ref().unwrap();
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].name, "guide.md");
    }

    #[test]
    fn scan_dir_tree_skips_hidden_files() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join(".hidden.md"), "secret").unwrap();
        fs::write(tmp.path().join("visible.md"), "public").unwrap();

        let entries = scan_dir_tree(tmp.path()).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "visible.md");
    }

    #[test]
    fn scan_dir_tree_excludes_empty_dirs() {
        let tmp = TempDir::new().unwrap();
        let empty_dir = tmp.path().join("empty");
        fs::create_dir(&empty_dir).unwrap();

        let entries = scan_dir_tree(tmp.path()).unwrap();
        assert!(entries.is_empty());
    }

    #[test]
    fn scan_dir_tree_sorts_dirs_before_files() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("zebra.md"), "z").unwrap();
        let sub = tmp.path().join("alpha");
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join("inner.md"), "i").unwrap();

        let entries = scan_dir_tree(tmp.path()).unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries[0].is_dir, "directory should come first");
        assert!(!entries[1].is_dir, "file should come second");
    }

    // --- Config default values ---

    #[test]
    fn config_default_values() {
        let config = Config::default();
        assert_eq!(config.theme, "dark");
        assert_eq!(config.font_size, 14);
        assert!(!config.vim_mode);
        assert!(!config.features.ai_copilot);
        assert!(config.features.diff_highlight);
        assert!(config.openrouter_api_key.is_none());
        assert!(config.ai_model.is_none());
    }

    // --- Session default values ---

    #[test]
    fn session_default_values() {
        let session = Session::default();
        assert!(session.open_tabs.is_empty());
        assert_eq!(session.active_tab, 0);
        assert!(session.vault_path.is_none());
        assert_eq!(session.view_mode, "split");
        assert!(session.sidebar_visible);
        assert!(session.pane_layout.is_none());
    }

    // --- Serialization round-trip ---

    #[test]
    fn session_serialization_roundtrip() {
        let session = Session {
            open_tabs: vec![TabInfo {
                path: "/tmp/test.md".to_string(),
                cursor_line: 10,
                cursor_col: 5,
                scroll_top: 120.5,
            }],
            active_tab: 0,
            vault_path: Some("/home/user/vault".to_string()),
            view_mode: "editor".to_string(),
            sidebar_visible: false,
            pane_layout: Some(PaneLayout {
                direction: "horizontal".to_string(),
                panes: vec![PaneInfo {
                    tab_id: Some("tab-1".to_string()),
                    size_percent: 50.0,
                }],
            }),
        };

        let json = serde_json::to_string(&session).unwrap();
        let restored: Session = serde_json::from_str(&json).unwrap();

        assert_eq!(restored.open_tabs.len(), 1);
        assert_eq!(restored.open_tabs[0].path, "/tmp/test.md");
        assert_eq!(restored.open_tabs[0].cursor_line, 10);
        assert_eq!(restored.active_tab, 0);
        assert_eq!(restored.vault_path.as_deref(), Some("/home/user/vault"));
        assert_eq!(restored.view_mode, "editor");
        assert!(!restored.sidebar_visible);
        let layout = restored.pane_layout.unwrap();
        assert_eq!(layout.direction, "horizontal");
        assert_eq!(layout.panes.len(), 1);
    }

    #[test]
    fn config_serialization_roundtrip() {
        let config = Config {
            theme: "light".to_string(),
            features: Features {
                ai_copilot: true,
                diff_highlight: false,
            },
            font_size: 18,
            vim_mode: true,
            openrouter_api_key: Some("sk-test-key".to_string()),
            ai_model: Some("openai/gpt-4o".to_string()),
        };

        let json = serde_json::to_string(&config).unwrap();
        let restored: Config = serde_json::from_str(&json).unwrap();

        assert_eq!(restored.theme, "light");
        assert!(restored.features.ai_copilot);
        assert!(!restored.features.diff_highlight);
        assert_eq!(restored.font_size, 18);
        assert!(restored.vim_mode);
        assert_eq!(restored.openrouter_api_key.as_deref(), Some("sk-test-key"));
        assert_eq!(restored.ai_model.as_deref(), Some("openai/gpt-4o"));
    }

    #[test]
    fn config_deserializes_with_missing_fields() {
        // Old config files may lack newer fields like ai_model
        let json = r#"{"theme":"dark","font_size":14,"vim_mode":false}"#;
        let config: Config = serde_json::from_str(json).unwrap();
        assert_eq!(config.theme, "dark");
        assert!(!config.features.ai_copilot); // default
        assert!(config.features.diff_highlight); // default
        assert!(config.openrouter_api_key.is_none()); // default
        assert!(config.ai_model.is_none()); // default
    }

    // --- Temp file naming convention ---

    #[test]
    fn temp_file_path_is_in_config_dir() {
        // Temp files should be stored in ~/.config/fude/tmp/
        let path = temp_file_path("/home/user/docs/notes.md").unwrap();
        let path_str = path.to_string_lossy();
        assert!(path_str.contains("fude"));
        assert!(path_str.contains("tmp"));
        assert!(path_str.contains("notes.md"));
    }

    #[test]
    fn temp_file_path_is_deterministic() {
        let path1 = temp_file_path("/home/user/docs/notes.md").unwrap();
        let path2 = temp_file_path("/home/user/docs/notes.md").unwrap();
        assert_eq!(path1, path2);
    }

    #[test]
    fn temp_file_path_differs_for_different_files() {
        let path1 = temp_file_path("/home/user/docs/notes.md").unwrap();
        let path2 = temp_file_path("/home/user/docs/other.md").unwrap();
        assert_ne!(path1, path2);
    }

    // --- BrowseResult / list_directory tests ---

    #[test]
    fn list_directory_returns_entries() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("file.txt"), "hello").unwrap();
        let sub = tmp.path().join("subdir");
        fs::create_dir(&sub).unwrap();

        let entries = list_directory(tmp.path()).unwrap();
        assert_eq!(entries.len(), 2);
        // Directories first
        assert!(entries[0].is_dir);
        assert_eq!(entries[0].name, "subdir");
        assert!(!entries[1].is_dir);
        assert_eq!(entries[1].name, "file.txt");
    }

    #[test]
    fn list_directory_skips_hidden() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join(".hidden"), "secret").unwrap();
        fs::write(tmp.path().join("visible.txt"), "public").unwrap();

        let entries = list_directory(tmp.path()).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "visible.txt");
    }

    #[test]
    fn list_directory_error_on_nonexistent() {
        let result = list_directory(Path::new("/nonexistent_dir_12345"));
        assert!(result.is_err());
    }

    #[test]
    fn browse_result_serialization_roundtrip() {
        let result = BrowseResult {
            current: "/home/user".to_string(),
            parent: "/home".to_string(),
            entries: vec![
                BrowseEntry {
                    name: "docs".to_string(),
                    path: "/home/user/docs".to_string(),
                    is_dir: true,
                },
                BrowseEntry {
                    name: "readme.txt".to_string(),
                    path: "/home/user/readme.txt".to_string(),
                    is_dir: false,
                },
            ],
        };

        let json = serde_json::to_string(&result).unwrap();
        let restored: BrowseResult = serde_json::from_str(&json).unwrap();

        assert_eq!(restored.current, "/home/user");
        assert_eq!(restored.parent, "/home");
        assert_eq!(restored.entries.len(), 2);
        assert!(restored.entries[0].is_dir);
        assert!(!restored.entries[1].is_dir);
    }

    #[test]
    fn temp_files_are_hidden_from_scan() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("notes.md"), "# Notes").unwrap();
        fs::write(tmp.path().join(".~notes.md.tmp"), "unsaved draft").unwrap();

        let entries = scan_dir_tree(tmp.path()).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "notes.md");
    }
}
