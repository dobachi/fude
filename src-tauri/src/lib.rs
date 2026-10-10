mod file_watcher;
mod gui_server;
mod key_storage;
mod updater_env;
mod wait_client;

use fude_core::{
    config_dir, ensure_config_dir, resolve_cli_path, set_dir_permissions, set_file_permissions,
    BrowseResult, Config, ConfigResponse, FileEntry, Session, TempFileInfo,
};
use futures_util::StreamExt;
use key_storage::{create_storage, KeyStorage};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::Emitter;
use tauri::Manager;
use tauri::{State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_cli::CliExt;

static KEY_STORAGE: OnceLock<Box<dyn KeyStorage>> = OnceLock::new();

// ─── Structs ───────────────────────────────────────────────

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
    // Check the primary storage chosen at startup first.
    let primary = get_key_storage();
    if let Some(key) = primary.get_key()? {
        if !key.is_empty() {
            return Ok(Some(key));
        }
    }
    // Fall back to looking directly at config.json. Covers the case where
    // a previous set_api_key call fell back to file storage because the
    // OS keychain accepted the write but couldn't return it on read-back
    // (observed on some Windows Credential Manager configurations).
    let path = config_dir()?.join("config.json");
    if path.exists() {
        let fallback = key_storage::ConfigFallbackStorage::new(path);
        return fallback.get_key();
    }
    Ok(None)
}

/// Locate the API key and report which storage type actually returned it.
/// Used by `get_config` so the UI shows the right "Stored in" hint.
fn locate_api_key() -> (bool, &'static str) {
    let primary = get_key_storage();
    if matches!(primary.get_key(), Ok(Some(ref k)) if !k.is_empty()) {
        return (true, primary.storage_type());
    }
    if let Ok(path) = config_dir().map(|d| d.join("config.json")) {
        if path.exists() {
            let fallback = key_storage::ConfigFallbackStorage::new(path);
            if matches!(fallback.get_key(), Ok(Some(ref k)) if !k.is_empty()) {
                return (true, "config_file");
            }
        }
    }
    (false, primary.storage_type())
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

// ─── Tauri Commands ────────────────────────────────────────
//
// Thin wrappers over fude_core so the same logic serves the CLI and the TUI.

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    fude_core::read_file(&path)
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    file_watcher::mark_self_save(Path::new(&path));
    fude_core::write_file(&path, &content)
}

/// Rename/move a file or directory.
#[tauri::command]
fn rename_path(from: String, to: String) -> Result<(), String> {
    fude_core::rename_path(&from, &to)
}

/// Move a file or directory to the OS trash/recycle bin.
#[tauri::command]
fn delete_path(path: String) -> Result<(), String> {
    fude_core::delete_path(&path)
}

/// Create a new empty file (errors if it already exists). Parent dirs created.
#[tauri::command]
fn create_file(path: String) -> Result<(), String> {
    fude_core::create_file(&path)
}

/// Create a new directory (errors if it already exists).
#[tauri::command]
fn create_directory(path: String) -> Result<(), String> {
    fude_core::create_directory(&path)
}

/// Returns the `assets/` directory next to the given document, creating it if needed.
fn assets_dir_for_doc(doc_path: &str) -> Result<PathBuf, String> {
    let parent = Path::new(doc_path)
        .parent()
        .ok_or_else(|| format!("Cannot determine parent directory of '{}'", doc_path))?;
    let assets = parent.join("assets");
    fs::create_dir_all(&assets).map_err(|e| {
        format!(
            "Failed to create assets directory '{}': {}",
            assets.display(),
            e
        )
    })?;
    Ok(assets)
}

/// Sanitizes a filename so it is safe inside a Markdown image path `![](...)`.
/// Spaces, parentheses, brackets and other URL/Markdown-breaking characters are
/// replaced with '-', then runs of '-' are collapsed. Unicode letters (e.g.
/// Japanese) are preserved. The extension is kept intact.
fn sanitize_basename(name: &str) -> String {
    let path = Path::new(name);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
    let ext = path.extension().and_then(|s| s.to_str());

    const UNSAFE: &str = "()[]<>#?%&{}|\\^~`\"'*:;,";
    let cleaned: String = stem
        .chars()
        .map(|c| {
            if c.is_whitespace() || c.is_control() || UNSAFE.contains(c) {
                '-'
            } else {
                c
            }
        })
        .collect();
    let collapsed = cleaned
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let stem = if collapsed.is_empty() {
        "image".to_string()
    } else {
        collapsed
    };

    match ext {
        Some(e) => format!("{}.{}", stem, e),
        None => stem,
    }
}

/// Returns a non-colliding path inside `assets_dir` for `basename` (e.g. "photo.png").
/// If the file already exists, appends a counter: "photo-1.png", "photo-2.png", ...
fn unique_asset_path(assets_dir: &Path, basename: &str) -> PathBuf {
    let candidate = assets_dir.join(basename);
    if !candidate.exists() {
        return candidate;
    }
    let base = Path::new(basename);
    let stem = base.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
    let ext = base.extension().and_then(|s| s.to_str());
    let mut n = 1;
    loop {
        let name = match ext {
            Some(e) => format!("{}-{}.{}", stem, n, e),
            None => format!("{}-{}", stem, n),
        };
        let candidate = assets_dir.join(&name);
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
    }
}

/// Copies an image file into the `assets/` folder beside `doc_path`.
/// Returns the inserted relative path (e.g. "assets/photo.png").
#[tauri::command]
fn copy_image_to_assets(src_path: String, doc_path: String) -> Result<String, String> {
    let assets = assets_dir_for_doc(&doc_path)?;
    let basename = Path::new(&src_path)
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| format!("Invalid source path '{}'", src_path))?;
    let basename = sanitize_basename(basename);
    let dest = unique_asset_path(&assets, &basename);
    fs::copy(&src_path, &dest).map_err(|e| {
        format!(
            "Failed to copy image '{}' to '{}': {}",
            src_path,
            dest.display(),
            e
        )
    })?;
    let name = dest
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(&basename);
    Ok(format!("assets/{}", name))
}

/// Writes raw image bytes (e.g. from a clipboard paste) into the `assets/` folder
/// beside `doc_path`. Returns the inserted relative path (e.g. "assets/pasted-image.png").
#[tauri::command]
fn save_image_bytes(bytes: Vec<u8>, doc_path: String, ext: String) -> Result<String, String> {
    let assets = assets_dir_for_doc(&doc_path)?;
    let ext = ext.trim_start_matches('.');
    let ext = if ext.is_empty() { "png" } else { ext };
    let basename = format!("pasted-image.{}", ext);
    let dest = unique_asset_path(&assets, &basename);
    fs::write(&dest, &bytes)
        .map_err(|e| format!("Failed to write image '{}': {}", dest.display(), e))?;
    let name = dest
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(&basename);
    Ok(format!("assets/{}", name))
}

#[tauri::command]
fn read_dir_tree(path: String, show_all_files: Option<bool>) -> Result<Vec<FileEntry>, String> {
    fude_core::scan_dir_tree_filtered(Path::new(&path), show_all_files.unwrap_or(false))
}

#[tauri::command]
fn load_session() -> Result<Option<Session>, String> {
    fude_core::load_session()
}

#[tauri::command]
fn save_session(session: Session) -> Result<(), String> {
    fude_core::save_session(&session)
}

#[tauri::command]
fn get_config() -> Result<ConfigResponse, String> {
    let config = fude_core::load_config()?;
    // locate_api_key checks the primary storage and then falls back to
    // config.json, so a key that was rescued by the set_api_key fallback
    // path still shows up as present here with the right storage label.
    let (has_api_key, storage_type) = locate_api_key();
    Ok(fude_core::config_response(
        config,
        has_api_key,
        storage_type,
    ))
}

#[tauri::command]
fn save_config(config: Config) -> Result<(), String> {
    fude_core::save_config(config)
}

#[tauri::command]
fn write_temp_file(path: String, content: String) -> Result<(), String> {
    fude_core::write_temp_file(&path, &content)
}

#[tauri::command]
fn delete_temp_file(path: String) -> Result<(), String> {
    fude_core::delete_temp_file(&path)
}

#[tauri::command]
fn check_temp_files(paths: Vec<String>) -> Result<Vec<TempFileInfo>, String> {
    fude_core::check_temp_files(paths)
}

#[tauri::command]
fn browse_dir(path: String) -> Result<BrowseResult, String> {
    fude_core::browse_dir(&path)
}

#[tauri::command]
fn set_api_key(key: String) -> Result<String, String> {
    let storage = get_key_storage();
    let primary_type = storage.storage_type();
    storage.set_key(&key)?;

    // Verify the write actually persisted. Some OS credential stores
    // (notably certain Windows Credential Manager configurations) accept
    // set_password but never return the credential on subsequent
    // get_password calls. If that happens, automatically fall back to
    // file storage so the user's save isn't lost.
    let verified = matches!(storage.get_key(), Ok(Some(ref stored)) if stored == &key);
    if !verified {
        // Clean up the orphan keychain entry that didn't round-trip.
        let _ = storage.delete_key();

        // Write directly to config.json via ConfigFallbackStorage.
        ensure_config_dir()?;
        let path = config_dir()?.join("config.json");
        let fallback = key_storage::ConfigFallbackStorage::new(path.clone());
        fallback.set_key(&key)?;

        // Verify the fallback worked too. If both fail we genuinely
        // cannot persist the key.
        match fallback.get_key()? {
            Some(stored) if stored == key => {}
            _ => {
                return Err(format!(
                    "Both {} and config file storage failed to retain the API key. \
                     Check filesystem permissions on the config directory.",
                    primary_type
                ));
            }
        }

        return Ok("config_file".to_string());
    }

    // Primary verified — if it's keychain, scrub any legacy plaintext from config.json
    if primary_type == "keychain" {
        let path = config_dir()?.join("config.json");
        if path.exists() {
            let content =
                fs::read_to_string(&path).map_err(|e| format!("Failed to read config: {}", e))?;
            let mut value: serde_json::Value = serde_json::from_str(&content)
                .map_err(|e| format!("Failed to parse config: {}", e))?;
            value["openrouter_api_key"] = serde_json::Value::Null;
            let content = serde_json::to_string_pretty(&value)
                .map_err(|e| format!("Failed to serialize config: {}", e))?;
            fs::write(&path, content).map_err(|e| format!("Failed to write config: {}", e))?;
            let _ = set_file_permissions(&path);
        }
    }

    Ok(primary_type.to_string())
}

#[tauri::command]
fn delete_api_key() -> Result<(), String> {
    let storage = get_key_storage();
    storage.delete_key()?;

    // Also clear from config.json
    let path = config_dir()?.join("config.json");
    if path.exists() {
        let content =
            fs::read_to_string(&path).map_err(|e| format!("Failed to read config: {}", e))?;
        let mut value: serde_json::Value =
            serde_json::from_str(&content).map_err(|e| format!("Failed to parse config: {}", e))?;
        value["openrouter_api_key"] = serde_json::Value::Null;
        let content = serde_json::to_string_pretty(&value)
            .map_err(|e| format!("Failed to serialize config: {}", e))?;
        fs::write(&path, content).map_err(|e| format!("Failed to write config: {}", e))?;
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
    let api_key = get_api_key()?.ok_or_else(|| "OpenRouter API key not configured".to_string())?;

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
    let api_key = get_api_key()?.ok_or_else(|| "OpenRouter API key not configured".to_string())?;

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

                    if let Some(data) = line.strip_prefix("data: ") {
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

                        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                            if let Some(content) = parsed["choices"][0]["delta"]["content"].as_str()
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

/// Returns (path, remote, new_window). `new_window` is true when `--new-window`
/// / `-n` is present, requesting the target open in a freshly spawned window.
fn parse_open_args(args: &[String]) -> (Option<String>, Option<String>, bool) {
    let mut path: Option<String> = None;
    let mut remote: Option<String> = None;
    let mut new_window = false;
    let mut i = 1;
    while i < args.len() {
        let a = &args[i];
        if a == "--remote" || a == "-r" {
            i += 1;
            if i < args.len() {
                remote = Some(args[i].clone());
            }
        } else if let Some(v) = a.strip_prefix("--remote=") {
            remote = Some(v.to_string());
        } else if a == "--new-window" || a == "-n" {
            new_window = true;
        } else if a.starts_with('-') {
            // unknown flag — skip
        } else if path.is_none() {
            path = Some(a.clone());
        }
        i += 1;
    }
    (path, remote, new_window)
}

/// Usage text printed by `fude --help`.
const CLI_USAGE: &str = "\
Usage: fude [OPTIONS] [PATH]
       fude browser [BROWSER OPTIONS]

Arguments:
  [PATH]  Path to a file or directory to open

Options:
  -r, --remote <URL>  Connect to a remote Fude server URL (e.g., http://localhost:3000)
  -n, --new-window    Open the file in a new window instead of reusing the existing one
  -w, --wait          Open PATH in the running Fude (starting one if needed) and
                      return only when its tab is closed; exit 1 if edits were
                      discarded. Lets Fude serve as $EDITOR / git core.editor.
  -h, --help          Print help
  -V, --version       Print version

Commands:
  browser  Serve Fude over HTTP and use it from a web browser (needs Node.js).
           Options cover the listen address, which IP ranges may connect
           (--allow), the access key and TLS: see `fude browser --help`.
           To open a file that is itself named \"browser\", pass ./browser.
";

/// Text to print for an informational flag (`--help` / `--version`), if one is
/// present in a raw argv slice (argv[0] = executable). When this returns
/// `Some`, the caller prints it and exits without starting the app: otherwise
/// tauri-plugin-cli merely records the flag and the window opens anyway (or,
/// via single-instance, an already-running window gets focused).
/// The value following `--remote` / `-r` and anything after `--` are operands,
/// never flags. `--help` wins over `--version` regardless of order.
fn cli_info_text(args: &[String]) -> Option<String> {
    let mut version = false;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--" => break,
            "--remote" | "-r" => i += 1,
            "--help" | "-h" => return Some(CLI_USAGE.to_string()),
            "--version" | "-V" => version = true,
            _ => {}
        }
        i += 1;
    }
    version.then(|| format!("fude {}\n", env!("CARGO_PKG_VERSION")))
}

// ─── `fude browser` subcommand ─────────────────────────────

/// Name of the subcommand that runs browser mode (`scripts/serve.js`).
const BROWSER_SUBCOMMAND: &str = "browser";

/// The arguments to hand to browser mode when argv (argv[0] = executable) is a
/// `fude browser ...` invocation; `None` for everything else. The subcommand is
/// only recognised as the first argument, so `fude notes/browser` and
/// `fude ./browser` still open a file.
fn browser_subcommand_args(args: &[String]) -> Option<&[String]> {
    match args.get(1) {
        Some(a) if a == BROWSER_SUBCOMMAND => Some(&args[2..]),
        _ => None,
    }
}

/// Where browser mode's server script and its static files live.
#[derive(Debug, Clone, PartialEq)]
struct BrowserAssets {
    serve: PathBuf,
    dist: PathBuf,
}

/// Places browser mode may be installed, relative to the directory holding the
/// executable, in the order they are tried. Bundled layouts keep `serve.js`
/// and the static files together (see `bundle.resources` in tauri.conf.json);
/// a development build runs from `src-tauri/target/<profile>/` and uses the
/// repository's `scripts/` and `dist/`.
fn browser_asset_candidates(exe_dir: &Path) -> Vec<BrowserAssets> {
    let bundled = |dir: PathBuf| BrowserAssets {
        serve: dir.join("serve.js"),
        dist: dir,
    };
    let mut out = vec![
        // Windows install / portable layout.
        bundled(exe_dir.join("browser")),
        // macOS: Fude.app/Contents/MacOS/fude -> Contents/Resources/browser.
        bundled(exe_dir.join("../Resources/browser")),
        // Linux deb / rpm / AppImage: usr/bin/fude -> usr/lib/Fude/browser.
        bundled(exe_dir.join("../lib/Fude/browser")),
        bundled(exe_dir.join("../lib/fude/browser")),
    ];
    let repo = exe_dir.join("../../..");
    out.push(BrowserAssets {
        serve: repo.join("scripts/serve.js"),
        dist: repo.join("dist"),
    });
    out
}

/// First candidate whose server script and static files both exist.
fn find_browser_assets(exe_dir: &Path) -> Option<BrowserAssets> {
    browser_asset_candidates(exe_dir)
        .into_iter()
        .find(|c| c.serve.is_file() && c.dist.join("index.html").is_file())
}

/// Run browser mode with `args` and return the process exit code. On Unix the
/// Node process replaces this one, so this only returns on failure.
fn run_browser_subcommand(args: &[String]) -> i32 {
    let exe = std::env::current_exe().and_then(|p| p.canonicalize());
    let assets = exe
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .and_then(|dir| find_browser_assets(&dir));
    let Some(assets) = assets else {
        eprintln!(
            "fude browser: browser mode files (serve.js) were not found next to this binary."
        );
        return 1;
    };

    let mut cmd = std::process::Command::new("node");
    cmd.arg(&assets.serve)
        .args(args)
        .env("FUDE_DIST_DIR", &assets.dist)
        .env("FUDE_PROG", "fude browser");

    #[cfg(unix)]
    let err = {
        use std::os::unix::process::CommandExt;
        cmd.exec()
    };
    #[cfg(not(unix))]
    let err = match cmd.status() {
        Ok(status) => return status.code().unwrap_or(1),
        Err(e) => e,
    };

    if err.kind() == std::io::ErrorKind::NotFound {
        eprintln!("fude browser: Node.js is required but `node` was not found in PATH.");
        return 127;
    }
    eprintln!("fude browser: failed to start node: {}", err);
    1
}

// ─── Multi-window support ──────────────────────────────────

/// A file path or remote URL queued for a window that is about to load. The
/// frontend pulls this via `take_open_request` during init.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct OpenRequest {
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub remote: Option<String>,
}

/// Pending open requests keyed by window label.
#[derive(Default)]
struct PendingOpens(Mutex<HashMap<String, OpenRequest>>);

/// Monotonic counter for additional window labels (`win-1`, `win-2`, ...).
static WINDOW_SEQ: AtomicUsize = AtomicUsize::new(1);

/// Spawn an additional editor window. When `remote` is set the window loads the
/// remote URL directly; otherwise it loads the bundled app and (if `path` is
/// given) the resolved path is queued for the new window to pull on init.
/// `base` is the working directory used to resolve a relative `path`.
///
/// IMPORTANT: `WebviewWindowBuilder::build()` deadlocks on Windows when called
/// on the main thread (e.g. directly from a synchronous command or the
/// single-instance handler, both of which run on the event-loop thread, which
/// is exactly the thread `build()` needs). We therefore resolve the URL and
/// queue any pending open synchronously, then run `build()` on a separate
/// thread so the caller's thread stays free to service the request.
fn spawn_window(
    app: &tauri::AppHandle,
    path: Option<String>,
    remote: Option<String>,
    base: Option<PathBuf>,
) -> Result<(), String> {
    let seq = WINDOW_SEQ.fetch_add(1, Ordering::SeqCst);
    let label = format!("win-{}", seq);

    let url = if let Some(r) = remote.as_deref().filter(|r| !r.is_empty()) {
        let parsed = r
            .parse()
            .map_err(|e| format!("Invalid remote URL '{}': {}", r, e))?;
        WebviewUrl::External(parsed)
    } else {
        if let Some(p) = path.filter(|p| !p.is_empty()) {
            let resolved = resolve_cli_path(&p, base.or_else(|| std::env::current_dir().ok()));
            if let Ok(mut map) = app.state::<PendingOpens>().0.lock() {
                map.insert(
                    label.clone(),
                    OpenRequest {
                        path: Some(resolved),
                        remote: None,
                    },
                );
            }
        }
        WebviewUrl::App("index.html".into())
    };

    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(e) = WebviewWindowBuilder::new(&app, &label, url)
            .title("Fude")
            .inner_size(1200.0, 800.0)
            .resizable(true)
            .build()
        {
            eprintln!("Failed to create window '{}': {}", label, e);
        }
    });
    Ok(())
}

/// Open a new editor window from the frontend (menu / shortcut / context menu).
#[tauri::command]
fn new_window(
    app: tauri::AppHandle,
    path: Option<String>,
    remote: Option<String>,
) -> Result<(), String> {
    spawn_window(&app, path, remote, None)
}

/// Pull (and clear) the open request queued for the calling window, if any.
#[tauri::command]
fn take_open_request(
    window: tauri::Window,
    pending: State<'_, PendingOpens>,
) -> Option<OpenRequest> {
    pending.0.lock().ok()?.remove(window.label())
}

// ─── `fude --wait` server ──────────────────────────────────

/// Opens paths requested over the IPC socket in the main window. The
/// frontend handles `cli-args` exactly as it does for single-instance
/// launches; `wait: true` additionally asks it to report the tab's closure
/// through `wait_tab_closed`.
struct WindowSink(tauri::AppHandle);

impl gui_server::OpenSink for WindowSink {
    fn open(&self, path: &str, wait: bool) -> Result<(), String> {
        let window = self
            .0
            .get_webview_window("main")
            .ok_or_else(|| "no main window".to_string())?;
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        window
            .emit(
                "cli-args",
                serde_json::json!({ "path": path, "wait": wait }),
            )
            .map_err(|e| e.to_string())
    }

    fn file_changed(&self, path: &str) {
        // Same event the native watcher emits, so the frontend reloads a
        // remote tab exactly like a local one.
        if let Some(window) = self.0.get_webview_window("main") {
            let _ = window.emit("file-changed", serde_json::json!({ "path": path }));
        }
    }

    fn disconnected(&self, host: &str) {
        if let Some(window) = self.0.get_webview_window("main") {
            let _ = window.emit("remote-disconnected", serde_json::json!({ "host": host }));
        }
    }
}

static GUI_SOCKET_STARTED: OnceLock<Result<String, String>> = OnceLock::new();

/// Loopback address the GUI also listens on (what `fude-cli` tries by
/// default and what an ssh `RemoteForward 47821 127.0.0.1:47821` targets).
const GUI_TCP_ADDR: &str = "127.0.0.1:47821";

/// Called by the main window once its `cli-args` listener is registered, so
/// no `open` can arrive before anyone is there to act on it. Idempotent:
/// later calls return the first outcome. Returns the socket path.
#[tauri::command]
fn gui_ready(
    app: tauri::AppHandle,
    registry: State<'_, Arc<gui_server::WaitRegistry>>,
    sessions: State<'_, Arc<gui_server::RemoteSessions>>,
) -> Result<String, String> {
    let registry = Arc::clone(&registry);
    let sessions = Arc::clone(&sessions);
    GUI_SOCKET_STARTED
        .get_or_init(|| {
            let dir = ensure_config_dir()?;
            let socket = fude_core::ipc::socket_path(&dir);
            gui_server::clear_stale_socket(&socket)?;
            let name = fude_core::ipc::socket_name(&socket).map_err(|e| e.to_string())?;
            // Remote agents must present this; see fude_core::token.
            let token = fude_core::token::load_or_create(&dir.join(fude_core::token::TOKEN_FILE))?;
            let sink: Arc<dyn gui_server::OpenSink> = Arc::new(WindowSink(app));
            gui_server::start(
                name,
                token.clone(),
                Arc::clone(&registry),
                Arc::clone(&sessions),
                Arc::clone(&sink),
            )
            .map_err(|e| format!("cannot listen on {}: {}", socket.display(), e))?;
            // Loopback TCP as well (token required from everyone there), so
            // Windows ssh clients and WSL can reach this GUI. `FUDE_GUI_TCP`
            // overrides the address; "off" disables it. Failure to bind
            // (port taken) is not fatal: the socket still works.
            let tcp = std::env::var("FUDE_GUI_TCP").unwrap_or_else(|_| GUI_TCP_ADDR.to_string());
            if tcp != "off" {
                match gui_server::start_tcp(&tcp, token, registry, sessions, sink) {
                    Ok(addr) => eprintln!("fude: also listening on tcp://{}", addr),
                    Err(e) => eprintln!("fude: not listening on tcp://{}: {}", tcp, e),
                }
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(&socket, fs::Permissions::from_mode(0o600));
            }
            Ok(socket.to_string_lossy().to_string())
        })
        .clone()
}

/// The frontend reports that the tab for `path` closed. `saved` is false
/// when unsaved edits were discarded. Returns how many waiters were told.
#[tauri::command]
fn wait_tab_closed(
    path: String,
    saved: bool,
    registry: State<'_, Arc<gui_server::WaitRegistry>>,
) -> usize {
    registry.tab_closed(&path, saved)
}

// ─── Files served by a remote agent (`remote://host/...`) ──

/// Prefix every path in a tree returned by an agent with its host, so the
/// frontend can hand any of them straight back to the `remote_*` commands.
fn prefix_tree(entries: &mut [FileEntry], host: &str) {
    for e in entries.iter_mut() {
        e.path = fude_core::ipc::remote_path(host, &e.path);
        if let Some(children) = e.children.as_mut() {
            prefix_tree(children, host);
        }
    }
}

#[tauri::command]
fn remote_read_file(
    path: String,
    sessions: State<'_, Arc<gui_server::RemoteSessions>>,
) -> Result<String, String> {
    let (session, p) = sessions.lookup(&path)?;
    let v = session.request(|id| fude_core::ipc::Message::ReadFile { id, path: p })?;
    v.as_str()
        .map(str::to_string)
        .ok_or_else(|| "agent returned no text".to_string())
}

#[tauri::command]
fn remote_write_file(
    path: String,
    content: String,
    sessions: State<'_, Arc<gui_server::RemoteSessions>>,
) -> Result<(), String> {
    let (session, p) = sessions.lookup(&path)?;
    session
        .request(|id| fude_core::ipc::Message::WriteFile {
            id,
            path: p,
            content,
        })
        .map(|_| ())
}

#[tauri::command]
fn remote_read_dir_tree(
    path: String,
    show_all_files: Option<bool>,
    sessions: State<'_, Arc<gui_server::RemoteSessions>>,
) -> Result<Vec<FileEntry>, String> {
    let (session, p) = sessions.lookup(&path)?;
    let host = session.host.clone();
    let v = session.request(|id| fude_core::ipc::Message::ReadDirTree {
        id,
        path: p,
        show_all_files: show_all_files.unwrap_or(false),
    })?;
    let mut entries: Vec<FileEntry> = serde_json::from_value(v).map_err(|e| e.to_string())?;
    prefix_tree(&mut entries, &host);
    Ok(entries)
}

#[tauri::command]
fn remote_watch_file(
    path: String,
    sessions: State<'_, Arc<gui_server::RemoteSessions>>,
) -> Result<(), String> {
    let (session, p) = sessions.lookup(&path)?;
    session
        .request(|id| fude_core::ipc::Message::Watch { id, path: p })
        .map(|_| ())
}

#[tauri::command]
fn remote_unwatch_file(
    path: String,
    sessions: State<'_, Arc<gui_server::RemoteSessions>>,
) -> Result<(), String> {
    let (session, p) = sessions.lookup(&path)?;
    session
        .request(|id| fude_core::ipc::Message::Unwatch { id, path: p })
        .map(|_| ())
}

/// Hosts with a connected agent (for the status bar / diagnostics).
#[tauri::command]
fn remote_hosts(sessions: State<'_, Arc<gui_server::RemoteSessions>>) -> Vec<String> {
    sessions.hosts()
}

// ─── Downloadable extensions ───────────────────────────────

/// URL of the extension catalogue. Pinned in-app; fetched over HTTPS.
const EXTENSION_MANIFEST_URL: &str =
    "https://raw.githubusercontent.com/dobachi/fude-extensions/main/manifest.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtensionFile {
    pub rel: String,
    pub url: String,
    pub sha256: String,
    #[serde(default)]
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtensionEntry {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub total_size: u64,
    pub files: Vec<ExtensionFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtensionManifest {
    #[serde(default)]
    pub schema: u32,
    pub extensions: Vec<ExtensionEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExtensionStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub dir: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct DownloadEvent {
    status: String, // "progress" | "done" | "error"
    progress: u64,
    total: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Root directory for installed extensions: `<config>/extensions`.
fn extensions_root() -> Result<PathBuf, String> {
    let dir = config_dir()?.join("extensions");
    if !dir.exists() {
        fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create extensions directory: {}", e))?;
    }
    Ok(dir)
}

/// Reject ids/versions that could escape the extensions directory.
fn is_safe_component(s: &str) -> bool {
    !s.is_empty()
        && s != "."
        && s != ".."
        && !s.contains('/')
        && !s.contains('\\')
        && !s.contains(':')
}

/// Find an installed version of `id` (a `<id>/<version>` dir holding `.complete`).
fn find_installed(id: &str) -> Option<(String, PathBuf)> {
    let root = extensions_root().ok()?;
    let id_dir = root.join(id);
    let entries = fs::read_dir(&id_dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && path.join(".complete").exists() {
            if let Some(ver) = path.file_name().and_then(|s| s.to_str()) {
                return Some((ver.to_string(), path));
            }
        }
    }
    None
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// Fetch the extension catalogue JSON (raw text) from the pinned URL.
#[tauri::command]
async fn fetch_extension_manifest() -> Result<String, String> {
    let client = reqwest::Client::new();
    let resp = client
        .get(EXTENSION_MANIFEST_URL)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch extension manifest: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("Manifest request failed: HTTP {}", resp.status()));
    }
    resp.text()
        .await
        .map_err(|e| format!("Failed to read manifest body: {}", e))
}

/// Report whether `id` is installed and where.
#[tauri::command]
fn extension_status(id: String) -> Result<ExtensionStatus, String> {
    if !is_safe_component(&id) {
        return Err(format!("Invalid extension id '{}'", id));
    }
    match find_installed(&id) {
        Some((version, dir)) => Ok(ExtensionStatus {
            installed: true,
            version: Some(version),
            dir: Some(dir.to_string_lossy().to_string()),
        }),
        None => Ok(ExtensionStatus {
            installed: false,
            version: None,
            dir: None,
        }),
    }
}

/// Return the absolute path to an installed extension file, e.g. ("plantuml",
/// "plantuml.js"). Used by the frontend to build an asset:// URL.
#[tauri::command]
fn extension_file_path(id: String, rel: String) -> Result<String, String> {
    if !is_safe_component(&id) || rel.contains("..") {
        return Err("Invalid extension path".to_string());
    }
    let (_ver, dir) =
        find_installed(&id).ok_or_else(|| format!("Extension '{}' not installed", id))?;
    let path = dir.join(&rel);
    if !path.exists() {
        return Err(format!("Extension file '{}' not found", rel));
    }
    Ok(path.to_string_lossy().to_string())
}

/// Return the text contents of an installed extension file. The frontend turns
/// this into a blob URL inside the sandboxed runner iframe, avoiding cross-origin
/// module-import (CORS) issues with the asset:// protocol.
#[tauri::command]
fn read_extension_file(id: String, rel: String) -> Result<String, String> {
    if !is_safe_component(&id) || rel.contains("..") || rel.contains('\\') {
        return Err("Invalid extension path".to_string());
    }
    let (_ver, dir) =
        find_installed(&id).ok_or_else(|| format!("Extension '{}' not installed", id))?;
    let path = dir.join(&rel);
    fs::read_to_string(&path).map_err(|e| format!("Failed to read '{}': {}", rel, e))
}

/// Remove an installed extension entirely.
#[tauri::command]
fn uninstall_extension(id: String) -> Result<(), String> {
    if !is_safe_component(&id) {
        return Err(format!("Invalid extension id '{}'", id));
    }
    let id_dir = extensions_root()?.join(&id);
    if id_dir.exists() {
        fs::remove_dir_all(&id_dir)
            .map_err(|e| format!("Failed to remove extension '{}': {}", id, e))?;
    }
    Ok(())
}

/// Download + verify + install the extension identified by `id`. Files are
/// fetched into a temp dir, sha256-verified against the manifest, and only then
/// promoted to `<id>/<version>`. Progress is emitted on `ext-download-<request_id>`.
#[tauri::command]
async fn install_extension(
    app: tauri::AppHandle,
    id: String,
    request_id: String,
) -> Result<(), String> {
    let event = format!("ext-download-{}", request_id);
    let result = install_extension_inner(&app, &id, &event).await;
    if let Err(ref e) = result {
        let _ = app.emit(
            &event,
            DownloadEvent {
                status: "error".to_string(),
                progress: 0,
                total: 0,
                error: Some(e.clone()),
            },
        );
    }
    result
}

async fn install_extension_inner(
    app: &tauri::AppHandle,
    id: &str,
    event: &str,
) -> Result<(), String> {
    if !is_safe_component(id) {
        return Err(format!("Invalid extension id '{}'", id));
    }

    // Resolve the manifest entry.
    let manifest_text = fetch_extension_manifest().await?;
    let manifest: ExtensionManifest = serde_json::from_str(&manifest_text)
        .map_err(|e| format!("Invalid manifest JSON: {}", e))?;
    let entry = manifest
        .extensions
        .into_iter()
        .find(|e| e.id == id)
        .ok_or_else(|| format!("Extension '{}' not found in manifest", id))?;
    if !is_safe_component(&entry.version) {
        return Err(format!("Invalid extension version '{}'", entry.version));
    }

    let total: u64 = if entry.total_size > 0 {
        entry.total_size
    } else {
        entry.files.iter().map(|f| f.size).sum()
    };

    let id_dir = extensions_root()?.join(id);
    fs::create_dir_all(&id_dir).map_err(|e| format!("Failed to create '{}': {}", id, e))?;
    let tmp_dir = id_dir.join(format!("{}.tmp", entry.version));
    if tmp_dir.exists() {
        let _ = fs::remove_dir_all(&tmp_dir);
    }
    fs::create_dir_all(&tmp_dir).map_err(|e| format!("Failed to create temp dir: {}", e))?;

    // Cleanup helper for rollback on any failure.
    let cleanup = |tmp: &Path| {
        let _ = fs::remove_dir_all(tmp);
    };

    let client = reqwest::Client::new();
    let mut downloaded: u64 = 0;

    for file in &entry.files {
        if file.rel.contains("..") || file.rel.contains('\\') {
            cleanup(&tmp_dir);
            return Err(format!("Invalid file path '{}'", file.rel));
        }
        let resp = match client.get(&file.url).send().await {
            Ok(r) => r,
            Err(e) => {
                cleanup(&tmp_dir);
                return Err(format!("Download failed for '{}': {}", file.rel, e));
            }
        };
        if !resp.status().is_success() {
            cleanup(&tmp_dir);
            return Err(format!(
                "Download failed for '{}': HTTP {}",
                file.rel,
                resp.status()
            ));
        }

        let mut stream = resp.bytes_stream();
        let mut buf: Vec<u8> = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = match chunk {
                Ok(c) => c,
                Err(e) => {
                    cleanup(&tmp_dir);
                    return Err(format!("Stream error on '{}': {}", file.rel, e));
                }
            };
            buf.extend_from_slice(&chunk);
            downloaded += chunk.len() as u64;
            let _ = app.emit(
                event,
                DownloadEvent {
                    status: "progress".to_string(),
                    progress: downloaded,
                    total,
                    error: None,
                },
            );
        }

        // Integrity check.
        let actual = sha256_hex(&buf);
        if !file.sha256.is_empty() && actual.to_lowercase() != file.sha256.to_lowercase() {
            cleanup(&tmp_dir);
            return Err(format!(
                "Checksum mismatch for '{}': expected {}, got {}",
                file.rel, file.sha256, actual
            ));
        }

        let dest = tmp_dir.join(&file.rel);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                cleanup(&tmp_dir);
                format!("Failed to create '{}': {}", parent.display(), e)
            })?;
        }
        if let Err(e) = fs::write(&dest, &buf) {
            cleanup(&tmp_dir);
            return Err(format!("Failed to write '{}': {}", file.rel, e));
        }
    }

    // Promote temp dir to the final versioned dir (replace any previous copy).
    let final_dir = id_dir.join(&entry.version);
    if final_dir.exists() {
        let _ = fs::remove_dir_all(&final_dir);
    }
    if let Err(e) = fs::rename(&tmp_dir, &final_dir) {
        cleanup(&tmp_dir);
        return Err(format!("Failed to finalize extension: {}", e));
    }
    // Mark complete.
    if let Err(e) = fs::write(final_dir.join(".complete"), entry.version.as_bytes()) {
        return Err(format!("Failed to mark extension complete: {}", e));
    }

    // Remove other (older) versions to save space.
    if let Ok(entries) = fs::read_dir(&id_dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() && p != final_dir {
                let _ = fs::remove_dir_all(&p);
            }
        }
    }

    let _ = app.emit(
        event,
        DownloadEvent {
            status: "done".to_string(),
            progress: total,
            total,
            error: None,
        },
    );
    Ok(())
}

pub fn run() {
    // Answer `--help` / `--version` and run `fude browser` before Tauri (and
    // single-instance) start, so no window is opened or focused.
    let raw_args: Vec<String> = std::env::args().collect();
    // `fude browser ...` is a different program (the HTTP server); its own
    // `--help` must reach it, so this is checked first.
    if let Some(rest) = browser_subcommand_args(&raw_args) {
        std::process::exit(run_browser_subcommand(rest));
    }
    if let Some(text) = cli_info_text(&raw_args) {
        print!("{}", text);
        return;
    }
    // `fude --wait ...` is a client of the running GUI, never a GUI itself.
    if let Some(paths) = wait_client::wait_paths(&raw_args) {
        let code = match config_dir() {
            Ok(dir) => wait_client::run(paths, &fude_core::ipc::socket_path(&dir)),
            Err(e) => {
                eprintln!("fude: {}", e);
                2
            }
        };
        std::process::exit(code);
    }

    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let (path, remote, new_window) = parse_open_args(&argv);
            let base = Some(PathBuf::from(&cwd));

            // `--new-window` (or no usable main window) spawns a fresh window;
            // otherwise reuse and focus the existing main window.
            if new_window {
                let _ = spawn_window(app, path, remote, base);
                return;
            }

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
                if let Some(p) = path {
                    let resolved = resolve_cli_path(&p, base);
                    // Target the main window only so other open windows are unaffected.
                    let _ = window.emit("cli-args", serde_json::json!({ "path": resolved }));
                }
            } else {
                let _ = spawn_window(app, path, remote, base);
            }
        }));
    }

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_cli::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .manage(PendingOpens::default())
        .manage(Arc::new(gui_server::WaitRegistry::default()))
        .manage(Arc::new(gui_server::RemoteSessions::default()))
        .invoke_handler(tauri::generate_handler![
            new_window,
            take_open_request,
            gui_ready,
            wait_tab_closed,
            remote_read_file,
            remote_write_file,
            remote_read_dir_tree,
            remote_watch_file,
            remote_unwatch_file,
            remote_hosts,
            read_file,
            write_file,
            rename_path,
            delete_path,
            create_file,
            create_directory,
            copy_image_to_assets,
            save_image_bytes,
            fetch_extension_manifest,
            extension_status,
            extension_file_path,
            read_extension_file,
            install_extension,
            uninstall_extension,
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
            updater_env::update_env,
            file_watcher::watch_file,
            file_watcher::unwatch_file,
            file_watcher::watch_directory,
            file_watcher::unwatch_directory,
        ])
        .setup(|app| {
            // Initialize key storage
            init_key_storage();

            // Migrate plaintext API key from config.json to keyring
            migrate_api_key();

            // Initialize file watcher (best-effort; failure logs but does not abort startup)
            if let Err(e) = file_watcher::init_watcher(app.handle().clone()) {
                eprintln!("File watcher init failed: {}", e);
            }

            let mut cli_path: Option<String> = None;
            let mut cli_remote: Option<String> = None;

            if let Ok(matches) = app.cli().matches() {
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
            }

            // Fallback: parse raw argv directly. Required for Windows file
            // association launches where the clap-based parser may not pick up
            // the bare path argument.
            if cli_path.is_none() && cli_remote.is_none() {
                let raw: Vec<String> = std::env::args().collect();
                let (p, r, _new_window) = parse_open_args(&raw);
                cli_path = p;
                cli_remote = r;
            }

            if let Some(remote_url) = cli_remote {
                if let Some(window) = app.get_webview_window("main") {
                    if let Ok(url) = remote_url.parse() {
                        let _ = window.navigate(url);
                    }
                }
            } else if let Some(path) = cli_path {
                // Queue the resolved path for the main window's `take_open_request`
                // call in init(). The previous 500ms-delayed `cli-args` emit raced
                // the frontend listener registration on slow webview startups
                // (notably Linux/WebKitGTK cold start), causing the event to be
                // dropped — Tauri events are not buffered. Queueing avoids the
                // race entirely.
                let resolved = resolve_cli_path(&path, std::env::current_dir().ok());
                if let Ok(mut map) = app.state::<PendingOpens>().0.lock() {
                    map.insert(
                        "main".to_string(),
                        OpenRequest {
                            path: Some(resolved),
                            remote: None,
                        },
                    );
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

    // --- cli_info_text ---

    #[test]
    fn cli_info_text_returns_usage_for_help_flags() {
        for flag in ["--help", "-h"] {
            let text = cli_info_text(&args(&["fude", flag])).expect("help text");
            assert!(text.starts_with("Usage: fude"));
            assert!(text.contains("--remote"));
            assert!(text.contains("--new-window"));
        }
    }

    #[test]
    fn cli_info_text_returns_version_for_version_flags() {
        let expected = format!("fude {}\n", env!("CARGO_PKG_VERSION"));
        for flag in ["--version", "-V"] {
            assert_eq!(
                cli_info_text(&args(&["fude", flag])),
                Some(expected.clone())
            );
        }
    }

    #[test]
    fn cli_info_text_none_for_normal_launches() {
        assert_eq!(cli_info_text(&[]), None);
        assert_eq!(cli_info_text(&args(&["fude"])), None);
        assert_eq!(cli_info_text(&args(&["fude", "/a.md"])), None);
        assert_eq!(
            cli_info_text(&args(&["fude", "-n", "-r", "http://x.test"])),
            None
        );
        assert_eq!(cli_info_text(&args(&["fude", "--debug"])), None);
    }

    #[test]
    fn cli_info_text_finds_help_among_other_args() {
        assert!(cli_info_text(&args(&["fude", "/a.md", "-n", "--help"])).is_some());
    }

    #[test]
    fn cli_info_text_help_wins_over_version() {
        let text = cli_info_text(&args(&["fude", "--version", "--help"])).unwrap();
        assert!(text.starts_with("Usage: fude"));
    }

    #[test]
    fn cli_info_text_ignores_executable_name() {
        assert_eq!(cli_info_text(&args(&["--help"])), None);
    }

    #[test]
    fn cli_info_text_does_not_treat_remote_value_as_flag() {
        assert_eq!(cli_info_text(&args(&["fude", "--remote", "-h"])), None);
        assert_eq!(cli_info_text(&args(&["fude", "-r", "--version"])), None);
        // A dangling `--remote` at the end must not panic.
        assert_eq!(cli_info_text(&args(&["fude", "--remote"])), None);
    }

    #[test]
    fn cli_info_text_stops_at_double_dash() {
        assert_eq!(cli_info_text(&args(&["fude", "--", "--help"])), None);
        assert!(cli_info_text(&args(&["fude", "--help", "--"])).is_some());
    }

    // --- fude browser subcommand ---

    #[test]
    fn cli_usage_points_to_browser_mode_help() {
        let text = cli_info_text(&args(&["fude", "--help"])).unwrap();
        assert!(text.contains("fude browser --help"));
        assert!(text.contains("--allow"));
    }

    #[test]
    fn browser_subcommand_args_returns_the_rest() {
        let a = args(&["fude", "browser", "--listen", "0.0.0.0", "--help"]);
        assert_eq!(browser_subcommand_args(&a), Some(&a[2..]),);
        let bare = args(&["fude", "browser"]);
        assert_eq!(browser_subcommand_args(&bare), Some(&bare[2..]));
        assert!(browser_subcommand_args(&bare).unwrap().is_empty());
    }

    #[test]
    fn browser_subcommand_args_only_matches_first_argument() {
        assert_eq!(browser_subcommand_args(&[]), None);
        assert_eq!(browser_subcommand_args(&args(&["fude"])), None);
        assert_eq!(browser_subcommand_args(&args(&["browser"])), None);
        assert_eq!(
            browser_subcommand_args(&args(&["fude", "/a.md", "browser"])),
            None
        );
        assert_eq!(
            browser_subcommand_args(&args(&["fude", "-n", "browser"])),
            None
        );
        assert_eq!(
            browser_subcommand_args(&args(&["fude", "--help", "browser"])),
            None
        );
        // Files that merely look like the subcommand still open as files.
        assert_eq!(browser_subcommand_args(&args(&["fude", "./browser"])), None);
        assert_eq!(
            browser_subcommand_args(&args(&["fude", "browser.md"])),
            None
        );
        assert_eq!(browser_subcommand_args(&args(&["fude", "Browser"])), None);
    }

    fn touch(path: &Path) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "").unwrap();
    }

    #[test]
    fn find_browser_assets_none_when_nothing_installed() {
        let tmp = tempfile::tempdir().unwrap();
        let exe_dir = tmp.path().join("usr/bin");
        fs::create_dir_all(&exe_dir).unwrap();
        assert_eq!(find_browser_assets(&exe_dir), None);
    }

    #[test]
    fn find_browser_assets_finds_linux_bundle() {
        let tmp = tempfile::tempdir().unwrap();
        let exe_dir = tmp.path().join("usr/bin");
        fs::create_dir_all(&exe_dir).unwrap();
        let browser = tmp.path().join("usr/lib/Fude/browser");
        touch(&browser.join("serve.js"));
        touch(&browser.join("index.html"));

        let found = find_browser_assets(&exe_dir).expect("assets");
        assert_eq!(
            found.serve.canonicalize().unwrap(),
            browser.join("serve.js").canonicalize().unwrap()
        );
        assert_eq!(
            found.dist.canonicalize().unwrap(),
            browser.canonicalize().unwrap()
        );
    }

    #[test]
    fn find_browser_assets_finds_dir_next_to_executable() {
        let tmp = tempfile::tempdir().unwrap();
        let browser = tmp.path().join("browser");
        touch(&browser.join("serve.js"));
        touch(&browser.join("index.html"));

        let found = find_browser_assets(tmp.path()).expect("assets");
        assert_eq!(found.serve, browser.join("serve.js"));
        assert_eq!(found.dist, browser);
    }

    #[test]
    fn find_browser_assets_finds_dev_checkout() {
        let tmp = tempfile::tempdir().unwrap();
        let exe_dir = tmp.path().join("src-tauri/target/debug");
        fs::create_dir_all(&exe_dir).unwrap();
        touch(&tmp.path().join("scripts/serve.js"));
        touch(&tmp.path().join("dist/index.html"));

        let found = find_browser_assets(&exe_dir).expect("assets");
        assert_eq!(
            found.serve.canonicalize().unwrap(),
            tmp.path().join("scripts/serve.js").canonicalize().unwrap()
        );
        assert_eq!(
            found.dist.canonicalize().unwrap(),
            tmp.path().join("dist").canonicalize().unwrap()
        );
    }

    #[test]
    fn find_browser_assets_skips_incomplete_install() {
        // serve.js without the static files (or the reverse) cannot serve anything.
        let tmp = tempfile::tempdir().unwrap();
        touch(&tmp.path().join("browser/serve.js"));
        assert_eq!(find_browser_assets(tmp.path()), None);

        let tmp = tempfile::tempdir().unwrap();
        touch(&tmp.path().join("browser/index.html"));
        assert_eq!(find_browser_assets(tmp.path()), None);
    }

    #[test]
    fn find_browser_assets_prefers_bundle_over_later_candidates() {
        let tmp = tempfile::tempdir().unwrap();
        let exe_dir = tmp.path().join("a/b/c");
        fs::create_dir_all(&exe_dir).unwrap();
        touch(&exe_dir.join("browser/serve.js"));
        touch(&exe_dir.join("browser/index.html"));
        touch(&tmp.path().join("scripts/serve.js"));
        touch(&tmp.path().join("dist/index.html"));

        let found = find_browser_assets(&exe_dir).expect("assets");
        assert_eq!(found.dist, exe_dir.join("browser"));
    }

    // --- parse_open_args ---

    fn args(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parse_open_args_extracts_path_from_positional_arg() {
        let (path, remote, _) = parse_open_args(&args(&["fude.exe", "C:\\Users\\me\\note.md"]));
        assert_eq!(path.as_deref(), Some("C:\\Users\\me\\note.md"));
        assert!(remote.is_none());
    }

    #[test]
    fn parse_open_args_handles_unix_path() {
        let (path, remote, _) = parse_open_args(&args(&["fude", "/home/user/notes.md"]));
        assert_eq!(path.as_deref(), Some("/home/user/notes.md"));
        assert!(remote.is_none());
    }

    #[test]
    fn parse_open_args_parses_remote_short_flag() {
        let (path, remote, _) = parse_open_args(&args(&["fude", "-r", "http://localhost:3000"]));
        assert!(path.is_none());
        assert_eq!(remote.as_deref(), Some("http://localhost:3000"));
    }

    #[test]
    fn parse_open_args_parses_remote_long_flag() {
        let (path, remote, _) = parse_open_args(&args(&["fude", "--remote", "http://example.com"]));
        assert_eq!(remote.as_deref(), Some("http://example.com"));
        assert!(path.is_none());
    }

    #[test]
    fn parse_open_args_parses_remote_equals_form() {
        let (path, remote, _) = parse_open_args(&args(&["fude", "--remote=http://x.test"]));
        assert_eq!(remote.as_deref(), Some("http://x.test"));
        assert!(path.is_none());
    }

    #[test]
    fn parse_open_args_returns_none_when_only_executable() {
        let (path, remote, _) = parse_open_args(&args(&["fude"]));
        assert!(path.is_none());
        assert!(remote.is_none());
    }

    #[test]
    fn parse_open_args_returns_none_for_empty() {
        let (path, remote, _) = parse_open_args(&[]);
        assert!(path.is_none());
        assert!(remote.is_none());
    }

    #[test]
    fn parse_open_args_takes_first_path_only() {
        let (path, _, _) = parse_open_args(&args(&["fude", "/a.md", "/b.md"]));
        assert_eq!(path.as_deref(), Some("/a.md"));
    }

    #[test]
    fn parse_open_args_skips_unknown_flags() {
        let (path, _, _) = parse_open_args(&args(&["fude", "--debug", "/a.md"]));
        assert_eq!(path.as_deref(), Some("/a.md"));
    }

    #[test]
    fn parse_open_args_detects_new_window_long_flag() {
        let (path, _, new_window) = parse_open_args(&args(&["fude", "--new-window", "/a.md"]));
        assert_eq!(path.as_deref(), Some("/a.md"));
        assert!(new_window);
    }

    #[test]
    fn parse_open_args_detects_new_window_short_flag() {
        let (path, _, new_window) = parse_open_args(&args(&["fude", "-n", "/a.md"]));
        assert_eq!(path.as_deref(), Some("/a.md"));
        assert!(new_window);
    }

    // --- PendingOpens main-window queue (cold-start CLI path delivery) ---

    #[test]
    fn prefix_tree_rewrites_every_path_recursively() {
        let mut tree = vec![FileEntry {
            name: "d".into(),
            path: "/r/d".into(),
            is_dir: true,
            children: Some(vec![FileEntry {
                name: "a.md".into(),
                path: "/r/d/a.md".into(),
                is_dir: false,
                children: None,
                modified: None,
                created: None,
                size: None,
            }]),
            modified: None,
            created: None,
            size: None,
        }];
        prefix_tree(&mut tree, "box");
        assert_eq!(tree[0].path, "remote://box/r/d");
        assert_eq!(
            tree[0].children.as_ref().unwrap()[0].path,
            "remote://box/r/d/a.md"
        );
    }

    #[test]
    fn pending_opens_queue_for_main_round_trips() {
        let state = PendingOpens::default();
        {
            let mut map = state.0.lock().unwrap();
            map.insert(
                "main".to_string(),
                OpenRequest {
                    path: Some("/tmp/note.md".to_string()),
                    remote: None,
                },
            );
        }

        // First take returns the entry and clears it (simulates `take_open_request`).
        let taken = state.0.lock().unwrap().remove("main");
        assert_eq!(taken.and_then(|r| r.path).as_deref(), Some("/tmp/note.md"));

        // Subsequent take returns None.
        let again = state.0.lock().unwrap().remove("main");
        assert!(again.is_none());
    }

    #[test]
    fn pending_opens_default_is_empty() {
        let state = PendingOpens::default();
        assert!(state.0.lock().unwrap().is_empty());
    }

    #[test]
    fn parse_open_args_new_window_defaults_false() {
        let (_, _, new_window) = parse_open_args(&args(&["fude", "/a.md"]));
        assert!(!new_window);
    }

    // --- resolve_cli_path tests ---

    // --- extension helpers ---

    #[test]
    fn sha256_hex_matches_known_vector() {
        // SHA-256("abc")
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn is_safe_component_rejects_traversal() {
        assert!(is_safe_component("plantuml"));
        assert!(is_safe_component("1.2026.5"));
        assert!(!is_safe_component(""));
        assert!(!is_safe_component("."));
        assert!(!is_safe_component(".."));
        assert!(!is_safe_component("a/b"));
        assert!(!is_safe_component("a\\b"));
        assert!(!is_safe_component("c:evil"));
    }

    #[test]
    fn extension_manifest_parses() {
        let json = r#"{
            "schema": 1,
            "extensions": [{
                "id": "plantuml",
                "name": "PlantUML Preview",
                "version": "1.2026.1",
                "total_size": 100,
                "files": [
                    { "rel": "plantuml.js", "url": "https://x/plantuml.js", "sha256": "ab", "size": 60 }
                ]
            }]
        }"#;
        let m: ExtensionManifest = serde_json::from_str(json).unwrap();
        assert_eq!(m.extensions.len(), 1);
        assert_eq!(m.extensions[0].id, "plantuml");
        assert_eq!(m.extensions[0].files[0].rel, "plantuml.js");
    }

    // --- sanitize_basename tests ---

    #[test]
    fn sanitize_basename_replaces_spaces_and_parens() {
        assert_eq!(
            sanitize_basename("Screenshot 2026-06-06 215104.png"),
            "Screenshot-2026-06-06-215104.png"
        );
        assert_eq!(sanitize_basename("photo 03 (1).jpg"), "photo-03-1.jpg");
    }

    #[test]
    fn sanitize_basename_collapses_dashes_and_keeps_extension() {
        assert_eq!(sanitize_basename("a   b___c.PNG"), "a-b___c.PNG");
        assert_eq!(
            sanitize_basename("weird[name]{x}.webp"),
            "weird-name-x.webp"
        );
    }

    #[test]
    fn sanitize_basename_preserves_unicode() {
        assert_eq!(sanitize_basename("図 1.png"), "図-1.png");
    }

    #[test]
    fn sanitize_basename_falls_back_when_empty_stem() {
        assert_eq!(sanitize_basename("   .png"), "image.png");
    }

    // --- unique_asset_path / image copy tests ---

    #[test]
    fn unique_asset_path_returns_basename_when_free() {
        let tmp = TempDir::new().unwrap();
        let p = unique_asset_path(tmp.path(), "photo.png");
        assert_eq!(p, tmp.path().join("photo.png"));
    }

    #[test]
    fn unique_asset_path_appends_counter_on_collision() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("photo.png"), b"a").unwrap();
        let p = unique_asset_path(tmp.path(), "photo.png");
        assert_eq!(p, tmp.path().join("photo-1.png"));

        fs::write(tmp.path().join("photo-1.png"), b"b").unwrap();
        let p = unique_asset_path(tmp.path(), "photo.png");
        assert_eq!(p, tmp.path().join("photo-2.png"));
    }

    #[test]
    fn unique_asset_path_handles_no_extension() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("image"), b"a").unwrap();
        let p = unique_asset_path(tmp.path(), "image");
        assert_eq!(p, tmp.path().join("image-1"));
    }

    #[test]
    fn copy_image_to_assets_creates_assets_and_returns_relative_path() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("source.png");
        fs::write(&src, b"PNGDATA").unwrap();
        let doc = tmp.path().join("note.md");

        let rel = copy_image_to_assets(
            src.to_str().unwrap().to_string(),
            doc.to_str().unwrap().to_string(),
        )
        .unwrap();
        assert_eq!(rel, "assets/source.png");
        let copied = tmp.path().join("assets/source.png");
        assert!(copied.exists());
        assert_eq!(fs::read(copied).unwrap(), b"PNGDATA");
    }

    #[test]
    fn copy_image_to_assets_avoids_overwrite() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("source.png");
        fs::write(&src, b"NEW").unwrap();
        let doc = tmp.path().join("note.md");
        fs::create_dir(tmp.path().join("assets")).unwrap();
        fs::write(tmp.path().join("assets/source.png"), b"OLD").unwrap();

        let rel = copy_image_to_assets(
            src.to_str().unwrap().to_string(),
            doc.to_str().unwrap().to_string(),
        )
        .unwrap();
        assert_eq!(rel, "assets/source-1.png");
        // original untouched
        assert_eq!(
            fs::read(tmp.path().join("assets/source.png")).unwrap(),
            b"OLD"
        );
    }

    #[test]
    fn save_image_bytes_writes_file_with_extension() {
        let tmp = TempDir::new().unwrap();
        let doc = tmp.path().join("note.md");
        let rel = save_image_bytes(
            b"BYTES".to_vec(),
            doc.to_str().unwrap().to_string(),
            "png".to_string(),
        )
        .unwrap();
        assert_eq!(rel, "assets/pasted-image.png");
        assert_eq!(
            fs::read(tmp.path().join("assets/pasted-image.png")).unwrap(),
            b"BYTES"
        );
    }

    #[test]
    fn save_image_bytes_defaults_extension_when_empty() {
        let tmp = TempDir::new().unwrap();
        let doc = tmp.path().join("note.md");
        let rel = save_image_bytes(
            b"X".to_vec(),
            doc.to_str().unwrap().to_string(),
            String::new(),
        )
        .unwrap();
        assert_eq!(rel, "assets/pasted-image.png");
    }
}
