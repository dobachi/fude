//! Report external changes to the files the GUI has open, as the desktop
//! app's own watcher does: watch each file's parent directory, filter to the
//! files of interest, and suppress what we just wrote ourselves. The folder
//! the GUI shows in its file tree is watched too, recursively, so that tree
//! follows files being added, removed and changed.

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher as _};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const SELF_SAVE_SUPPRESS: Duration = Duration::from_millis(2000);

/// At most one report per watched directory in this long. A burst (a
/// checkout, a copy of many files) would otherwise cross the connection
/// event by event. It must stay shorter than the time the GUI waits before
/// it rescans (file-watcher.js), so that what is dropped here is still seen
/// by the scan the report before it leads to.
const DIR_REPORT_INTERVAL: Duration = Duration::from_millis(100);

/// What the watcher reports.
#[derive(Debug, Clone, PartialEq)]
pub enum Change {
    /// A watched file changed.
    File(PathBuf),
    /// Something under a watched directory changed. Carries the directory
    /// as the GUI named it.
    Dir(PathBuf),
}

struct DirWatch {
    /// The path the GUI asked for (the key is its canonical form).
    asked: PathBuf,
    reported: Option<Instant>,
}

/// Decides which raw filesystem events become reports. Pure, so it is
/// tested without a real watcher.
#[derive(Default)]
pub struct Filter {
    files: HashSet<PathBuf>,
    dirs: HashMap<PathBuf, DirWatch>,
    self_saves: HashMap<PathBuf, Instant>,
}

/// Whether `path`, somewhere below `root`, is hidden: the file tree skips
/// dot files and dot folders (`.git` above all), so their churn is not news.
fn hidden_below(root: &Path, path: &Path) -> bool {
    path.strip_prefix(root)
        .map(|rel| {
            rel.components()
                .any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
        })
        .unwrap_or(false)
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

    pub fn add_dir(&mut self, path: &Path) {
        self.dirs.entry(canonical(path)).or_insert(DirWatch {
            asked: path.to_path_buf(),
            reported: None,
        });
    }

    pub fn remove_dir(&mut self, path: &Path) {
        self.dirs.remove(&canonical(path));
    }

    /// The watched directories (as they were asked for) that `paths` say
    /// changed: not by our own recent writes, not in hidden places, and not
    /// reported a moment ago already.
    pub fn report_dirs(&mut self, paths: &[PathBuf], now: Instant) -> Vec<PathBuf> {
        self.self_saves
            .retain(|_, t| now.duration_since(*t) < SELF_SAVE_SUPPRESS);
        let mut out = Vec::new();
        for (root, watch) in self.dirs.iter_mut() {
            let news = paths.iter().any(|p| {
                p.starts_with(root)
                    && !hidden_below(root, p)
                    && !self.self_saves.contains_key(&canonical(p))
            });
            let recent = watch
                .reported
                .is_some_and(|t| now.duration_since(t) < DIR_REPORT_INTERVAL);
            if news && !recent {
                watch.reported = Some(now);
                out.push(watch.asked.clone());
            }
        }
        out
    }
}

pub struct Watcher {
    inner: RecommendedWatcher,
    /// Watches the file tree's folder. An instance of its own, so that a
    /// recursive watch and a file's parent watch on the same directory do
    /// not replace or release each other.
    tree: RecommendedWatcher,
    /// Reference-counted parent directories under watch.
    dirs: HashMap<PathBuf, usize>,
    /// Reference-counted directories watched recursively.
    trees: HashMap<PathBuf, usize>,
    filter: Arc<Mutex<Filter>>,
}

/// Whether `event` is one that changes what a file or a folder holds.
fn changes_content(event: &Event) -> bool {
    matches!(
        event.kind,
        EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
    )
}

impl Watcher {
    /// Changes are sent to `tx`.
    pub fn new(tx: Sender<Change>) -> Result<Watcher, String> {
        let filter = Arc::new(Mutex::new(Filter::default()));
        let f = Arc::clone(&filter);
        let file_tx = tx.clone();
        let inner = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            let Ok(event) = res else { return };
            if !changes_content(&event) {
                return;
            }
            let changed = match f.lock() {
                Ok(mut filter) => filter.report(&event.paths, Instant::now()),
                Err(_) => return,
            };
            for p in changed {
                let _ = file_tx.send(Change::File(p));
            }
        })
        .map_err(|e| format!("cannot create file watcher: {}", e))?;
        let f = Arc::clone(&filter);
        let tree = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            let Ok(event) = res else { return };
            if !changes_content(&event) {
                return;
            }
            let changed = match f.lock() {
                Ok(mut filter) => filter.report_dirs(&event.paths, Instant::now()),
                Err(_) => return,
            };
            for p in changed {
                let _ = tx.send(Change::Dir(p));
            }
        })
        .map_err(|e| format!("cannot create directory watcher: {}", e))?;
        Ok(Watcher {
            inner,
            tree,
            dirs: HashMap::new(),
            trees: HashMap::new(),
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

    fn watch_dir(&mut self, path: &Path) -> Result<(), String> {
        let dir = canonical(path);
        let count = self.trees.entry(dir.clone()).or_insert(0);
        if *count == 0 {
            if let Err(e) = self.tree.watch(&dir, RecursiveMode::Recursive) {
                self.trees.remove(&dir);
                return Err(format!("cannot watch '{}': {}", dir.display(), e));
            }
            if let Ok(mut f) = self.filter.lock() {
                f.add_dir(path);
            }
        }
        if let Some(count) = self.trees.get_mut(&dir) {
            *count += 1;
        }
        Ok(())
    }

    fn unwatch_dir(&mut self, path: &Path) -> Result<(), String> {
        let dir = canonical(path);
        if let Some(count) = self.trees.get_mut(&dir) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                self.trees.remove(&dir);
                let _ = self.tree.unwatch(&dir);
                if let Ok(mut f) = self.filter.lock() {
                    f.remove_dir(path);
                }
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

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn a_change_anywhere_under_a_watched_directory_reports_that_directory() {
        let mut f = Filter::default();
        let root = p("/nonexistent/notes");
        f.add_dir(&root);
        let t0 = Instant::now();
        // Outside, and a sibling that merely shares the prefix.
        assert!(f
            .report_dirs(&[p("/nonexistent/other/a.md")], t0)
            .is_empty());
        assert!(f
            .report_dirs(&[p("/nonexistent/notes2/a.md")], t0)
            .is_empty());
        // Nested, however deep: the directory, once per event.
        assert_eq!(
            f.report_dirs(
                &[
                    p("/nonexistent/notes/sub/deep/new.md"),
                    p("/nonexistent/notes/b.md")
                ],
                t0
            ),
            vec![root.clone()]
        );

        f.remove_dir(&root);
        assert!(f
            .report_dirs(&[p("/nonexistent/notes/b.md")], t0 + Duration::from_secs(5))
            .is_empty());
    }

    #[test]
    fn hidden_places_under_a_watched_directory_are_not_news() {
        let mut f = Filter::default();
        // The root itself may be hidden: only what is below it counts.
        let root = p("/nonexistent/.vault");
        f.add_dir(&root);
        let t0 = Instant::now();
        assert!(f
            .report_dirs(&[p("/nonexistent/.vault/.git/index.lock")], t0)
            .is_empty());
        assert!(f
            .report_dirs(&[p("/nonexistent/.vault/sub/.a.md.swp")], t0)
            .is_empty());
        // One visible path among hidden ones is enough.
        assert_eq!(
            f.report_dirs(
                &[
                    p("/nonexistent/.vault/.git/HEAD"),
                    p("/nonexistent/.vault/sub/a.md")
                ],
                t0
            ),
            vec![root]
        );
    }

    #[test]
    fn a_burst_is_reported_once_and_our_own_writes_not_at_all() {
        let mut f = Filter::default();
        let root = p("/nonexistent/notes");
        let a = p("/nonexistent/notes/a.md");
        let b = p("/nonexistent/notes/b.md");
        f.add_dir(&root);
        let t0 = Instant::now();
        assert_eq!(
            f.report_dirs(std::slice::from_ref(&a), t0),
            vec![root.clone()]
        );
        // Within the interval: dropped. At its end: reported again.
        assert!(f
            .report_dirs(
                std::slice::from_ref(&b),
                t0 + DIR_REPORT_INTERVAL - Duration::from_millis(1)
            )
            .is_empty());
        let t1 = t0 + DIR_REPORT_INTERVAL;
        assert_eq!(
            f.report_dirs(std::slice::from_ref(&b), t1),
            vec![root.clone()]
        );

        // A write of ours says nothing, and does not start the interval
        // for somebody else's change either.
        let t2 = t1 + Duration::from_secs(1);
        f.mark_self_save(&a, t2);
        assert!(f.report_dirs(std::slice::from_ref(&a), t2).is_empty());
        assert_eq!(
            f.report_dirs(&[a.clone(), b.clone()], t2),
            vec![root.clone()]
        );
        assert_eq!(
            f.report_dirs(
                std::slice::from_ref(&a),
                t2 + SELF_SAVE_SUPPRESS + Duration::from_millis(1)
            ),
            vec![root]
        );
    }

    #[test]
    fn a_directory_asked_for_twice_keeps_its_first_entry() {
        let mut f = Filter::default();
        let root = p("/nonexistent/notes");
        f.add_dir(&root);
        let t0 = Instant::now();
        assert_eq!(
            f.report_dirs(&[p("/nonexistent/notes/a.md")], t0),
            vec![root.clone()]
        );
        // Asking again must not forget that it was just reported.
        f.add_dir(&root);
        assert!(f
            .report_dirs(
                &[p("/nonexistent/notes/a.md")],
                t0 + Duration::from_millis(1)
            )
            .is_empty());
    }

    /// The real thing: a file created in a subfolder of a watched directory
    /// arrives as a change of that directory.
    #[test]
    fn a_real_watcher_reports_a_file_added_below_the_directory() {
        use crate::agent::Side as _;
        let dir = tempfile::TempDir::new().unwrap();
        let sub = dir.path().join("sub");
        std::fs::create_dir(&sub).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let mut w = Watcher::new(tx).unwrap();
        w.watch_dir(dir.path()).unwrap();
        std::fs::write(sub.join("new.md"), "x").unwrap();
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(10)).unwrap(),
            Change::Dir(dir.path().to_path_buf())
        );

        // Once released, nothing more is said.
        w.unwatch_dir(dir.path()).unwrap();
        while rx.recv_timeout(Duration::from_millis(300)).is_ok() {}
        std::fs::write(sub.join("later.md"), "x").unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(500)).is_err());
    }
}
