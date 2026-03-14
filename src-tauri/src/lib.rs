use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use tauri::Emitter;
use tauri_plugin_cli::CliExt;

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
pub struct Features {
    pub ai_copilot: bool,
    pub diff_highlight: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub theme: String,
    pub features: Features,
    pub font_size: u32,
    pub vim_mode: bool,
    pub openrouter_api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TempFileInfo {
    pub original_path: String,
    pub temp_path: String,
    pub modified: String,
}

// ─── Helpers ───────────────────────────────────────────────

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

#[tauri::command]
fn get_config() -> Result<Config, String> {
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
fn save_config(config: Config) -> Result<(), String> {
    let dir = ensure_config_dir()?;
    let path = dir.join("config.json");
    let content = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    fs::write(&path, content).map_err(|e| format!("Failed to write config file: {}", e))
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
            write_temp_file,
            delete_temp_file,
            check_temp_files,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            if let Ok(matches) = app.cli().matches() {
                let mut cli_path: Option<String> = None;

                if let Some(arg) = matches.args.get("path") {
                    if let Some(val) = arg.value.as_str() {
                        let s = val.to_string();
                        if !s.is_empty() {
                            cli_path = Some(s);
                        }
                    }
                }

                if let Some(path) = cli_path {
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
        };

        let json = serde_json::to_string(&config).unwrap();
        let restored: Config = serde_json::from_str(&json).unwrap();

        assert_eq!(restored.theme, "light");
        assert!(restored.features.ai_copilot);
        assert!(!restored.features.diff_highlight);
        assert_eq!(restored.font_size, 18);
        assert!(restored.vim_mode);
        assert_eq!(restored.openrouter_api_key.as_deref(), Some("sk-test-key"));
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
