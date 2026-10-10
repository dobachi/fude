//! The file tree pane: the GUI's sidebar listing (`fude_core::scan_dir_tree`)
//! flattened for a list widget, with per-directory expansion.

use fude_core::FileEntry;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub path: PathBuf,
    pub name: String,
    pub is_dir: bool,
    pub depth: usize,
    pub expanded: bool,
}

#[derive(Debug, Default)]
pub struct Sidebar {
    pub root: Option<PathBuf>,
    tree: Vec<FileEntry>,
    expanded: HashSet<PathBuf>,
    pub rows: Vec<Row>,
    pub selected: usize,
    pub visible: bool,
}

impl Sidebar {
    /// Load `root`. Top-level directories start expanded so a small vault is
    /// visible at once.
    pub fn open(&mut self, root: &Path) -> Result<(), String> {
        let tree = fude_core::scan_dir_tree_filtered(root, false)?;
        self.root = Some(root.to_path_buf());
        self.expanded = tree
            .iter()
            .filter(|e| e.is_dir)
            .map(|e| PathBuf::from(&e.path))
            .collect();
        self.tree = tree;
        self.visible = true;
        self.selected = 0;
        self.rebuild();
        Ok(())
    }

    /// Re-read the tree (external changes), keeping expansion and selection.
    pub fn refresh(&mut self) {
        if let Some(root) = self.root.clone() {
            if let Ok(tree) = fude_core::scan_dir_tree_filtered(&root, false) {
                let keep = self.rows.get(self.selected).map(|r| r.path.clone());
                self.tree = tree;
                self.rebuild();
                if let Some(p) = keep {
                    if let Some(i) = self.rows.iter().position(|r| r.path == p) {
                        self.selected = i;
                    }
                }
            }
        }
    }

    fn rebuild(&mut self) {
        let mut rows = Vec::new();
        fn walk(
            entries: &[FileEntry],
            depth: usize,
            expanded: &HashSet<PathBuf>,
            out: &mut Vec<Row>,
        ) {
            for e in entries {
                let path = PathBuf::from(&e.path);
                let is_open = e.is_dir && expanded.contains(&path);
                out.push(Row {
                    path: path.clone(),
                    name: e.name.clone(),
                    is_dir: e.is_dir,
                    depth,
                    expanded: is_open,
                });
                if is_open {
                    if let Some(children) = &e.children {
                        walk(children, depth + 1, expanded, out);
                    }
                }
            }
        }
        walk(&self.tree, 0, &self.expanded, &mut rows);
        self.rows = rows;
        if self.selected >= self.rows.len() {
            self.selected = self.rows.len().saturating_sub(1);
        }
    }

    pub fn move_by(&mut self, delta: i32) {
        if self.rows.is_empty() {
            return;
        }
        let n = self.rows.len() as i32;
        self.selected = (self.selected as i32 + delta).clamp(0, n - 1) as usize;
    }

    /// Enter on a directory toggles it; on a file returns the path to open.
    pub fn activate(&mut self) -> Option<PathBuf> {
        let row = self.rows.get(self.selected)?.clone();
        if row.is_dir {
            if !self.expanded.remove(&row.path) {
                self.expanded.insert(row.path);
            }
            self.rebuild();
            None
        } else {
            Some(row.path)
        }
    }

    /// Select the row for `path`, expanding its parents, if it is in the tree.
    pub fn reveal(&mut self, path: &Path) {
        let Some(root) = &self.root else { return };
        let mut dir = path.parent();
        while let Some(d) = dir {
            if d == root {
                break;
            }
            self.expanded.insert(d.to_path_buf());
            dir = d.parent();
        }
        self.rebuild();
        if let Some(i) = self.rows.iter().position(|r| r.path == path) {
            self.selected = i;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn lists_markdown_files_with_top_level_dirs_expanded() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("b.md"), "").unwrap();
        fs::create_dir_all(tmp.path().join("a/deep")).unwrap();
        fs::write(tmp.path().join("a/x.md"), "").unwrap();
        fs::write(tmp.path().join("a/deep/y.md"), "").unwrap();
        fs::write(tmp.path().join("ignored.txt"), "").unwrap();
        let mut sb = Sidebar::default();
        sb.open(tmp.path()).unwrap();
        let names: Vec<(String, usize)> =
            sb.rows.iter().map(|r| (r.name.clone(), r.depth)).collect();
        assert_eq!(
            names,
            vec![
                ("a".into(), 0),
                ("deep".into(), 1),
                ("x.md".into(), 1),
                ("b.md".into(), 0)
            ]
        );

        // Enter on "deep" expands it; on a file returns it.
        sb.selected = 1;
        assert_eq!(sb.activate(), None);
        assert_eq!(sb.rows[2].name, "y.md");
        sb.selected = 2;
        assert_eq!(sb.activate(), Some(tmp.path().join("a/deep/y.md")));
        sb.selected = 1;
        sb.activate(); // collapse again
        assert_eq!(sb.rows.len(), 4);

        sb.move_by(100);
        assert_eq!(sb.selected, 3);
        sb.move_by(-100);
        assert_eq!(sb.selected, 0);

        sb.reveal(&tmp.path().join("a/deep/y.md"));
        assert_eq!(sb.rows[sb.selected].name, "y.md");
    }
}
