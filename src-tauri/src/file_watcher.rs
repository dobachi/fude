// file_watcher.rs - External file change detection.
//
// Watches the parent directory of each tracked file and emits `file-changed`
// events to the frontend. Suppresses notifications for paths Fude itself
// just wrote to (to avoid self-triggering after save).

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const SELF_SAVE_SUPPRESS: Duration = Duration::from_millis(2000);

struct WatcherState {
    watcher: RecommendedWatcher,
    /// Reference-counted directories the watcher is observing.
    dirs: HashMap<PathBuf, usize>,
    /// Files we care about — events on other files in the same dir are dropped.
    files: HashSet<PathBuf>,
    /// Timestamps of recent self-saves keyed by canonicalized path.
    self_saves: HashMap<PathBuf, Instant>,
}

static STATE: OnceLock<Mutex<Option<WatcherState>>> = OnceLock::new();

fn lock_state() -> std::sync::MutexGuard<'static, Option<WatcherState>> {
    STATE.get_or_init(|| Mutex::new(None)).lock().unwrap()
}

fn canonicalize(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

#[derive(Serialize, Clone)]
struct FileChangeEvent {
    path: String,
}

pub fn init_watcher(app: AppHandle) -> Result<(), String> {
    let app_clone = app.clone();
    let watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
        if let Ok(event) = res {
            handle_event(&app_clone, event);
        }
    })
    .map_err(|e| format!("Failed to create file watcher: {}", e))?;

    let mut s = lock_state();
    *s = Some(WatcherState {
        watcher,
        dirs: HashMap::new(),
        files: HashSet::new(),
        self_saves: HashMap::new(),
    });
    Ok(())
}

fn handle_event(app: &AppHandle, event: Event) {
    if !matches!(
        event.kind,
        EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
    ) {
        return;
    }

    let mut s = lock_state();
    let Some(state) = s.as_mut() else { return };

    let now = Instant::now();
    state
        .self_saves
        .retain(|_, t| now.duration_since(*t) < SELF_SAVE_SUPPRESS);

    for path in event.paths {
        let canonical = canonicalize(&path);
        if !state.files.contains(&canonical) {
            continue;
        }
        if state
            .self_saves
            .get(&canonical)
            .map(|t| now.duration_since(*t) < SELF_SAVE_SUPPRESS)
            .unwrap_or(false)
        {
            continue;
        }
        let _ = app.emit(
            "file-changed",
            FileChangeEvent {
                path: canonical.to_string_lossy().into_owned(),
            },
        );
    }
}

pub fn mark_self_save(path: &Path) {
    let mut s = lock_state();
    let Some(state) = s.as_mut() else { return };
    let canonical = canonicalize(path);
    state.self_saves.insert(canonical, Instant::now());
}

#[tauri::command]
pub fn watch_file(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let canonical = p
        .canonicalize()
        .map_err(|e| format!("Cannot canonicalize '{}': {}", path, e))?;
    let parent = canonical
        .parent()
        .ok_or_else(|| format!("'{}' has no parent directory", path))?
        .to_path_buf();

    let mut s = lock_state();
    let state = s
        .as_mut()
        .ok_or_else(|| "watcher not initialized".to_string())?;

    if !state.files.insert(canonical) {
        return Ok(());
    }

    let count = state.dirs.entry(parent.clone()).or_insert(0);
    if *count == 0 {
        state
            .watcher
            .watch(&parent, RecursiveMode::NonRecursive)
            .map_err(|e| format!("watch failed: {}", e))?;
    }
    *count += 1;
    Ok(())
}

#[tauri::command]
pub fn unwatch_file(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let canonical = canonicalize(&p);
    let Some(parent) = canonical.parent().map(|p| p.to_path_buf()) else {
        return Ok(());
    };

    let mut s = lock_state();
    let Some(state) = s.as_mut() else {
        return Ok(());
    };

    if !state.files.remove(&canonical) {
        return Ok(());
    }

    if let Some(count) = state.dirs.get_mut(&parent) {
        *count = count.saturating_sub(1);
        if *count == 0 {
            let _ = state.watcher.unwatch(&parent);
            state.dirs.remove(&parent);
        }
    }
    Ok(())
}
