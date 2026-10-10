//! Report external changes to the files the GUI has open, as the desktop
//! app's own watcher does: watch each file's parent directory, filter to the
//! files of interest, and suppress what we just wrote ourselves.

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher as _};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const SELF_SAVE_SUPPRESS: Duration = Duration::from_millis(2000);

/// Decides which raw filesystem events become reports. Pure, so it is
/// tested without a real watcher.
#[derive(Default)]
pub struct Filter {
    files: HashSet<PathBuf>,
    self_saves: HashMap<PathBuf, Instant>,
}

fn canonical(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

impl Filter {
    pub fn add(&mut self, path: &Path) {
        self.files.insert(canonical(path));
    }

    pub fn remove(&mut self, path: &Path) {
        self.files.remove(&canonical(path));
    }

    pub fn mark_self_save(&mut self, path: &Path, now: Instant) {
        self.self_saves.insert(canonical(path), now);
    }

    /// The watched files among `paths` that changed and were not our own
    /// recent writes.
    pub fn report(&mut self, paths: &[PathBuf], now: Instant) -> Vec<PathBuf> {
        self.self_saves
            .retain(|_, t| now.duration_since(*t) < SELF_SAVE_SUPPRESS);
        paths
            .iter()
            .map(|p| canonical(p))
            .filter(|p| self.files.contains(p) && !self.self_saves.contains_key(p))
            .collect()
    }
}

pub struct Watcher {
    inner: RecommendedWatcher,
    /// Reference-counted parent directories under watch.
    dirs: HashMap<PathBuf, usize>,
    filter: Arc<Mutex<Filter>>,
}

impl Watcher {
    /// Changed paths are sent to `tx`.
    pub fn new(tx: Sender<PathBuf>) -> Result<Watcher, String> {
        let filter = Arc::new(Mutex::new(Filter::default()));
        let f = Arc::clone(&filter);
        let inner = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            let Ok(event) = res else { return };
            if !matches!(
                event.kind,
                EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
            ) {
                return;
            }
            let changed = match f.lock() {
                Ok(mut filter) => filter.report(&event.paths, Instant::now()),
                Err(_) => return,
            };
            for p in changed {
                let _ = tx.send(p);
            }
        })
        .map_err(|e| format!("cannot create file watcher: {}", e))?;
        Ok(Watcher {
            inner,
            dirs: HashMap::new(),
            filter,
        })
    }

    fn parent(path: &Path) -> Result<PathBuf, String> {
        path.parent()
            .map(canonical)
            .ok_or_else(|| format!("'{}' has no parent directory", path.display()))
    }
}

impl crate::agent::Side for Watcher {
    fn before_write(&mut self, path: &Path) {
        if let Ok(mut f) = self.filter.lock() {
            f.mark_self_save(path, Instant::now());
        }
    }

    fn watch(&mut self, path: &Path) -> Result<(), String> {
        let dir = Self::parent(path)?;
        let count = self.dirs.entry(dir.clone()).or_insert(0);
        if *count == 0 {
            self.inner
                .watch(&dir, RecursiveMode::NonRecursive)
                .map_err(|e| format!("cannot watch '{}': {}", dir.display(), e))?;
        }
        *count += 1;
        if let Ok(mut f) = self.filter.lock() {
            f.add(path);
        }
        Ok(())
    }

    fn unwatch(&mut self, path: &Path) -> Result<(), String> {
        if let Ok(mut f) = self.filter.lock() {
            f.remove(path);
        }
        let dir = Self::parent(path)?;
        if let Some(count) = self.dirs.get_mut(&dir) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                self.dirs.remove(&dir);
                let _ = self.inner.unwatch(&dir);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_watched_files_are_reported_and_self_saves_are_suppressed() {
        let mut f = Filter::default();
        let a = PathBuf::from("/nonexistent/a.md");
        let b = PathBuf::from("/nonexistent/b.md");
        f.add(&a);
        let t0 = Instant::now();
        assert_eq!(f.report(&[a.clone(), b.clone()], t0), vec![a.clone()]);

        f.mark_self_save(&a, t0);
        assert!(f
            .report(std::slice::from_ref(&a), t0 + Duration::from_millis(500))
            .is_empty());
        assert_eq!(
            f.report(
                std::slice::from_ref(&a),
                t0 + SELF_SAVE_SUPPRESS + Duration::from_millis(1)
            ),
            vec![a.clone()]
        );

        f.remove(&a);
        assert!(f
            .report(std::slice::from_ref(&a), t0 + Duration::from_secs(10))
            .is_empty());
    }
}
