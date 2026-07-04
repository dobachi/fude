// file_watcher.rs - External file change detection.
//
// Two independent concerns, each backed by its own notify watcher instance so
// their (potentially overlapping) watched paths never collide:
//   1. Per-open-file watching — watches the parent directory of each tracked
//      file (NonRecursive) and emits `file-changed` so the editor can reload.
//   2. Vault watching — watches the open folder (Recursive) and emits
//      `directory-changed` so the sidebar file tree can refresh when files are
//      added, removed, renamed, or modified anywhere under the vault.
// Both suppress notifications for paths Fude itself just wrote to (to avoid
// self-triggering after save).

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const SELF_SAVE_SUPPRESS: Duration = Duration::from_millis(2000);

struct WatcherState {
    watcher: RecommendedWatcher,
    /// Recursive watcher for open vault directories. A separate notify instance
    /// from `watcher` so a vault watch and a per-file parent watch on the same
    /// (or nested) path never fight over one inotify descriptor.
    vault_watcher: RecommendedWatcher,
    /// Reference-counted directories the watcher is observing.
    dirs: HashMap<PathBuf, usize>,
    /// Reference-counted files we care about — events on other files in the same
    /// dir are dropped. Counted (not a set) so multiple windows watching the same
    /// file don't undo each other's watch on close.
    files: HashMap<PathBuf, usize>,
    /// Reference-counted vault roots watched recursively for tree changes.
    vaults: HashMap<PathBuf, usize>,
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

#[derive(Serialize, Clone)]
struct DirectoryChangeEvent {
    path: String,
}

pub fn init_watcher(app: AppHandle) -> Result<(), String> {
    let app_file = app.clone();
    let watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
        if let Ok(event) = res {
            handle_event(&app_file, event);
        }
    })
    .map_err(|e| format!("Failed to create file watcher: {}", e))?;

    let app_dir = app.clone();
    let vault_watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
        if let Ok(event) = res {
            handle_dir_event(&app_dir, event);
        }
    })
    .map_err(|e| format!("Failed to create directory watcher: {}", e))?;

    let mut s = lock_state();
    *s = Some(WatcherState {
        watcher,
        vault_watcher,
        dirs: HashMap::new(),
        files: HashMap::new(),
        vaults: HashMap::new(),
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
        if !state.files.contains_key(&canonical) {
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

/// Emit `directory-changed` for any watched vault a changed path lives under, so
/// the sidebar tree can refresh. Skips Fude's own recent writes.
fn handle_dir_event(app: &AppHandle, event: Event) {
    if !matches!(
        event.kind,
        EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
    ) {
        return;
    }

    let mut s = lock_state();
    let Some(state) = s.as_mut() else { return };
    if state.vaults.is_empty() {
        return;
    }

    let now = Instant::now();
    state
        .self_saves
        .retain(|_, t| now.duration_since(*t) < SELF_SAVE_SUPPRESS);

    // Collect each affected vault root once (a single fs op can report several
    // paths), skipping paths Fude itself just wrote.
    let mut roots: Vec<PathBuf> = Vec::new();
    for path in &event.paths {
        let canonical = canonicalize(path);
        if state
            .self_saves
            .get(&canonical)
            .map(|t| now.duration_since(*t) < SELF_SAVE_SUPPRESS)
            .unwrap_or(false)
        {
            continue;
        }
        for root in state.vaults.keys() {
            if path.starts_with(root) && !roots.contains(root) {
                roots.push(root.clone());
            }
        }
    }

    for root in roots {
        let _ = app.emit(
            "directory-changed",
            DirectoryChangeEvent {
                path: root.to_string_lossy().into_owned(),
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

    // Already tracked by another tab/window: just bump the file refcount.
    let file_count = state.files.entry(canonical).or_insert(0);
    *file_count += 1;
    if *file_count > 1 {
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

    // Decrement the file refcount; only release the directory watch once the
    // last tab/window watching this file has unwatched it.
    match state.files.get_mut(&canonical) {
        Some(count) => {
            *count = count.saturating_sub(1);
            if *count > 0 {
                return Ok(());
            }
            state.files.remove(&canonical);
        }
        None => return Ok(()),
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

/// Begin watching a vault directory recursively for tree changes.
#[tauri::command]
pub fn watch_directory(path: String) -> Result<(), String> {
    let canonical = PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| format!("Cannot canonicalize '{}': {}", path, e))?;

    let mut s = lock_state();
    let state = s
        .as_mut()
        .ok_or_else(|| "watcher not initialized".to_string())?;

    let count = state.vaults.entry(canonical.clone()).or_insert(0);
    *count += 1;
    if *count > 1 {
        return Ok(());
    }

    if let Err(e) = state
        .vault_watcher
        .watch(&canonical, RecursiveMode::Recursive)
    {
        state.vaults.remove(&canonical);
        return Err(format!("watch failed: {}", e));
    }
    Ok(())
}

/// Stop watching a vault directory. No-op if it was never watched.
#[tauri::command]
pub fn unwatch_directory(path: String) -> Result<(), String> {
    let canonical = canonicalize(&PathBuf::from(&path));

    let mut s = lock_state();
    let Some(state) = s.as_mut() else {
        return Ok(());
    };

    if let Some(count) = state.vaults.get_mut(&canonical) {
        *count = count.saturating_sub(1);
        if *count == 0 {
            let _ = state.vault_watcher.unwatch(&canonical);
            state.vaults.remove(&canonical);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Install a real (event-discarding) watcher without needing a Tauri AppHandle.
    fn init_test_watcher() {
        let watcher = notify::recommended_watcher(|_res: Result<Event, notify::Error>| {}).unwrap();
        let vault_watcher =
            notify::recommended_watcher(|_res: Result<Event, notify::Error>| {}).unwrap();
        let mut s = lock_state();
        *s = Some(WatcherState {
            watcher,
            vault_watcher,
            dirs: HashMap::new(),
            files: HashMap::new(),
            vaults: HashMap::new(),
            self_saves: HashMap::new(),
        });
    }

    #[test]
    fn multi_watch_refcounts_until_last_unwatch() {
        init_test_watcher();

        let dir = std::env::temp_dir().join("fude_fw_refcount_test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("note.md");
        fs::write(&file, "x").unwrap();
        let path = file.to_string_lossy().to_string();
        let canonical = canonicalize(&file);

        // Two windows watch the same file.
        watch_file(path.clone()).unwrap();
        watch_file(path.clone()).unwrap();
        {
            let s = lock_state();
            let st = s.as_ref().unwrap();
            assert_eq!(st.files.get(&canonical).copied(), Some(2));
        }

        // First window closes the file: still watched by the second.
        unwatch_file(path.clone()).unwrap();
        {
            let s = lock_state();
            let st = s.as_ref().unwrap();
            assert_eq!(st.files.get(&canonical).copied(), Some(1));
            assert!(!st.dirs.is_empty(), "directory watch must persist");
        }

        // Second window closes: fully released.
        unwatch_file(path.clone()).unwrap();
        {
            let s = lock_state();
            let st = s.as_ref().unwrap();
            assert!(st.files.get(&canonical).is_none());
            assert!(st.dirs.is_empty(), "directory watch must be released");
        }

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn vault_watch_refcounts_until_last_unwatch() {
        init_test_watcher();

        let dir = std::env::temp_dir().join("fude_fw_vault_test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.to_string_lossy().to_string();
        let canonical = canonicalize(&dir);

        // Two windows open the same vault.
        watch_directory(path.clone()).unwrap();
        watch_directory(path.clone()).unwrap();
        {
            let s = lock_state();
            let st = s.as_ref().unwrap();
            assert_eq!(st.vaults.get(&canonical).copied(), Some(2));
        }

        // First window closes: still watched by the second.
        unwatch_directory(path.clone()).unwrap();
        {
            let s = lock_state();
            let st = s.as_ref().unwrap();
            assert_eq!(st.vaults.get(&canonical).copied(), Some(1));
        }

        // Second window closes: fully released.
        unwatch_directory(path.clone()).unwrap();
        {
            let s = lock_state();
            let st = s.as_ref().unwrap();
            assert!(st.vaults.get(&canonical).is_none());
            assert!(st.vaults.is_empty(), "vault watch must be released");
        }

        // Unwatching an unknown path is a harmless no-op.
        unwatch_directory(path.clone()).unwrap();

        let _ = fs::remove_dir_all(&dir);
    }
}
