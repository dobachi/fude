//! The file-serving half of the agent: answers the GUI's requests for the
//! files it was started with, and nothing outside them.

use fude_core::ipc::Message;
use std::path::{Component, Path, PathBuf};

/// Side effects the request handler needs from its host (the watcher).
/// Separated so the handler can be tested without one.
pub trait Side {
    /// About to write `path` ourselves: don't report it as an external change.
    fn before_write(&mut self, path: &Path);
    fn watch(&mut self, path: &Path) -> Result<(), String>;
    fn unwatch(&mut self, path: &Path) -> Result<(), String>;
}

pub struct Agent {
    /// Directories the GUI may read and write under.
    roots: Vec<PathBuf>,
}

/// Lexically normalize an absolute path: drop `.`, reject `..`, so a request
/// cannot step out of a root through the path string.
fn normalize(path: &str) -> Option<PathBuf> {
    let p = Path::new(path);
    if !p.is_absolute() {
        return None;
    }
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => return None,
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    Some(out)
}

impl Agent {
    /// `paths` are absolute. A directory is served whole; a file exposes its
    /// parent directory (so links to siblings, images in `assets/` and
    /// "save as" next to the file keep working).
    pub fn new(paths: &[String]) -> Agent {
        let mut roots: Vec<PathBuf> = Vec::new();
        for p in paths {
            let Some(abs) = normalize(p) else { continue };
            let root = if abs.is_dir() {
                abs
            } else {
                abs.parent().map(Path::to_path_buf).unwrap_or(abs)
            };
            if !roots.contains(&root) {
                roots.push(root);
            }
        }
        Agent { roots }
    }

    pub fn roots(&self) -> &[PathBuf] {
        &self.roots
    }

    pub fn allowed(&self, path: &str) -> bool {
        match normalize(path) {
            Some(p) => self.roots.iter().any(|r| p.starts_with(r)),
            None => false,
        }
    }

    /// Answer a request. Non-requests yield `None`.
    pub fn handle(&self, msg: &Message, side: &mut dyn Side) -> Option<Message> {
        let id = msg.request_id()?;
        let path = match msg {
            Message::ReadFile { path, .. }
            | Message::WriteFile { path, .. }
            | Message::ReadDirTree { path, .. }
            | Message::Watch { path, .. }
            | Message::Unwatch { path, .. } => path,
            _ => return None,
        };
        if !self.allowed(path) {
            return Some(Message::err(
                id,
                format!("'{}' is outside what this fude-cli serves", path),
            ));
        }
        let result = match msg {
            Message::ReadFile { .. } => fude_core::read_file(path).map(serde_json::Value::String),
            Message::WriteFile { content, .. } => {
                side.before_write(Path::new(path));
                fude_core::write_file(path, content).map(|_| serde_json::Value::Null)
            }
            Message::ReadDirTree { show_all_files, .. } => {
                fude_core::scan_dir_tree_filtered(Path::new(path), *show_all_files)
                    .and_then(|t| serde_json::to_value(t).map_err(|e| e.to_string()))
            }
            Message::Watch { .. } => side.watch(Path::new(path)).map(|_| serde_json::Value::Null),
            Message::Unwatch { .. } => side
                .unwatch(Path::new(path))
                .map(|_| serde_json::Value::Null),
            _ => return None,
        };
        Some(match result {
            Ok(v) => Message::ok(id, v),
            Err(e) => Message::err(id, e),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[derive(Default)]
    struct Rec {
        writes: Vec<PathBuf>,
        watches: Vec<PathBuf>,
    }
    impl Side for Rec {
        fn before_write(&mut self, path: &Path) {
            self.writes.push(path.to_path_buf());
        }
        fn watch(&mut self, path: &Path) -> Result<(), String> {
            self.watches.push(path.to_path_buf());
            Ok(())
        }
        fn unwatch(&mut self, path: &Path) -> Result<(), String> {
            self.watches.retain(|p| p != path);
            Ok(())
        }
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().to_string()
    }

    #[test]
    fn a_file_exposes_its_directory_and_a_directory_itself() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("notes");
        fs::create_dir(&dir).unwrap();
        fs::write(dir.join("a.md"), "").unwrap();
        let other = tmp.path().join("other");
        fs::create_dir(&other).unwrap();

        let ag = Agent::new(&[s(&dir.join("a.md")), s(&other), "relative.md".into()]);
        assert_eq!(ag.roots(), &[dir.clone(), other.clone()]);
        assert!(ag.allowed(&s(&dir.join("b.md"))));
        assert!(ag.allowed(&s(&dir.join("sub/./c.md"))));
        assert!(ag.allowed(&s(&other)));
        assert!(!ag.allowed(&s(&tmp.path().join("secret.md"))));
        assert!(!ag.allowed(&s(&dir.join("../secret.md"))));
        assert!(!ag.allowed("relative.md"));
        // Sibling directory that merely shares a prefix.
        assert!(!ag.allowed(&format!("{}2/x.md", s(&dir))));
    }

    #[test]
    fn requests_inside_a_root_are_served_and_outside_refused() {
        let tmp = TempDir::new().unwrap();
        let f = tmp.path().join("a.md");
        fs::write(&f, "hello").unwrap();
        let ag = Agent::new(&[s(&f)]);
        let mut side = Rec::default();

        let r = ag
            .handle(&Message::ReadFile { id: 1, path: s(&f) }, &mut side)
            .unwrap();
        assert_eq!(r, Message::ok(1, serde_json::Value::String("hello".into())));

        let out = s(&tmp.path().join("../outside.md"));
        let r = ag
            .handle(&Message::ReadFile { id: 2, path: out }, &mut side)
            .unwrap();
        assert!(matches!(
            r,
            Message::Result {
                id: 2,
                error: Some(_),
                ..
            }
        ));

        let r = ag
            .handle(
                &Message::WriteFile {
                    id: 3,
                    path: s(&tmp.path().join("new/b.md")),
                    content: "x".into(),
                },
                &mut side,
            )
            .unwrap();
        assert_eq!(r, Message::ok(3, serde_json::Value::Null));
        assert_eq!(
            fs::read_to_string(tmp.path().join("new/b.md")).unwrap(),
            "x"
        );
        assert_eq!(side.writes, vec![tmp.path().join("new/b.md")]);

        let r = ag
            .handle(
                &Message::ReadDirTree {
                    id: 4,
                    path: s(tmp.path()),
                    show_all_files: false,
                },
                &mut side,
            )
            .unwrap();
        let Message::Result { ok: Some(v), .. } = r else {
            panic!("expected ok");
        };
        let names: Vec<&str> = v
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["new", "a.md"]);

        ag.handle(&Message::Watch { id: 5, path: s(&f) }, &mut side);
        assert_eq!(side.watches, vec![f.clone()]);
        ag.handle(&Message::Unwatch { id: 6, path: s(&f) }, &mut side);
        assert!(side.watches.is_empty());

        assert!(ag.handle(&Message::Bye, &mut side).is_none());
        assert!(ag
            .handle(
                &Message::Result {
                    id: 9,
                    ok: None,
                    error: None
                },
                &mut side
            )
            .is_none());
    }
}
