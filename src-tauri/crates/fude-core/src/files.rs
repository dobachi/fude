//! Files and the sidebar tree.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Option<Vec<FileEntry>>,
    pub modified: Option<u64>,
    pub created: Option<u64>,
    pub size: Option<u64>,
}

pub fn read_file(path: &str) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| format!("Failed to read file '{}': {}", path, e))
}

/// Write `content`, creating missing parent directories.
pub fn write_file(path: &str, content: &str) -> Result<(), String> {
    let file_path = Path::new(path);
    if let Some(parent) = file_path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| {
                format!("Failed to create parent directories for '{}': {}", path, e)
            })?;
        }
    }
    fs::write(path, content).map_err(|e| format!("Failed to write file '{}': {}", path, e))
}

/// Rename/move a file or directory.
pub fn rename_path(from: &str, to: &str) -> Result<(), String> {
    if from.is_empty() || to.is_empty() {
        return Err("Invalid path".to_string());
    }
    if Path::new(to).exists() {
        return Err(format!("'{}' already exists", to));
    }
    fs::rename(from, to).map_err(|e| format!("Failed to rename '{}': {}", from, e))
}

/// Move a file or directory to the OS trash/recycle bin.
pub fn delete_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("Invalid path".to_string());
    }
    trash::delete(path).map_err(|e| format!("Failed to move '{}' to trash: {}", path, e))
}

/// Create a new empty file (errors if it already exists). Parent dirs created.
pub fn create_file(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    if p.exists() {
        return Err(format!("'{}' already exists", path));
    }
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent of '{}': {}", path, e))?;
    }
    fs::write(path, "").map_err(|e| format!("Failed to create '{}': {}", path, e))
}

/// Create a new directory (errors if it already exists).
pub fn create_directory(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    if p.exists() {
        return Err(format!("'{}' already exists", path));
    }
    fs::create_dir_all(path).map_err(|e| format!("Failed to create directory '{}': {}", path, e))
}

fn get_file_metadata(path: &Path) -> (Option<u64>, Option<u64>, Option<u64>) {
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return (None, None, None),
    };
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs());
    let created = meta
        .created()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs());
    let size = Some(meta.len());
    (modified, created, size)
}

/// The sidebar tree with the default filter (Markdown, diagrams, images).
pub fn scan_dir_tree(dir: &Path) -> Result<Vec<FileEntry>, String> {
    scan_dir_tree_filtered(dir, false)
}

/// File extensions shown in the sidebar by default (without "show all files"):
/// Markdown variants, PlantUML sources, and images (Fude previews these too).
pub fn is_listed_file(name: &str) -> bool {
    const EXTS: &[&str] = &[
        // Markdown
        ".md",
        ".markdown",
        ".mdown",
        ".mkd",
        ".mkdn",
        ".qmd",
        // PlantUML
        ".puml",
        ".plantuml",
        ".uml",
        ".iuml",
        ".pu",
        ".wsd",
        // Mermaid
        ".mmd",
        ".mermaid",
        // Images
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".webp",
        ".bmp",
        ".svg",
        ".avif",
        ".ico",
    ];
    let lower = name.to_lowercase();
    EXTS.iter().any(|e| lower.ends_with(e))
}

/// The sidebar tree. Hidden entries are skipped, empty directories dropped,
/// directories sorted first. Don't gate on `is_dir()` first: on some
/// network/UNC paths (e.g. WSL's \\wsl.localhost\...) metadata can be flaky
/// and falsely report "not a directory"; scanning directly lets the real OS
/// error surface and genuine directories still open.
pub fn scan_dir_tree_filtered(dir: &Path, show_all_files: bool) -> Result<Vec<FileEntry>, String> {
    let mut ancestors: Vec<PathBuf> = Vec::new();
    scan_dir_tree_inner(dir, show_all_files, &mut ancestors)
}

/// Directory test that follows symlinks. `DirEntry::file_type()` reports a
/// symlink as a symlink (never a directory), so a symlinked folder would be
/// treated as a file and dropped by the extension filter. Common on WSL and
/// in dotfile/skill setups where folders are linked into a vault.
fn entry_is_dir(entry: &fs::DirEntry) -> bool {
    match entry.file_type() {
        Ok(ft) if ft.is_dir() => true,
        Ok(ft) if ft.is_symlink() => fs::metadata(entry.path())
            .map(|m| m.is_dir())
            .unwrap_or(false),
        _ => false,
    }
}

/// Recursive scan. `ancestors` holds the canonical paths of the directories
/// currently being scanned so a symlink pointing back at an ancestor stops
/// instead of recursing forever.
fn scan_dir_tree_inner(
    dir: &Path,
    show_all_files: bool,
    ancestors: &mut Vec<PathBuf>,
) -> Result<Vec<FileEntry>, String> {
    let canonical = fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    if ancestors.contains(&canonical) {
        return Ok(Vec::new());
    }
    ancestors.push(canonical);
    let result = scan_dir_entries(dir, show_all_files, ancestors);
    ancestors.pop();
    result
}

fn scan_dir_entries(
    dir: &Path,
    show_all_files: bool,
    ancestors: &mut Vec<PathBuf>,
) -> Result<Vec<FileEntry>, String> {
    let mut entries = Vec::new();

    let read_dir = fs::read_dir(dir)
        .map_err(|e| format!("Failed to read directory '{}': {}", dir.display(), e))?;

    // Resolve is_dir once per entry (it may hit the filesystem for symlinks)
    // and sort on it: directories first, then by name.
    let mut items: Vec<(fs::DirEntry, bool)> = read_dir
        .filter_map(|entry| entry.ok())
        .map(|entry| {
            let is_dir = entry_is_dir(&entry);
            (entry, is_dir)
        })
        .collect();

    items.sort_by(|(a, a_is_dir), (b, b_is_dir)| match (a_is_dir, b_is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.file_name().cmp(&b.file_name()),
    });

    for (item, is_dir) in items {
        let name = item.file_name().to_string_lossy().to_string();
        let path = item.path();

        // Skip hidden files and directories
        if name.starts_with('.') {
            continue;
        }

        if is_dir {
            // Be resilient: a subdirectory we can't read (permissions, special
            // network entries on WSL/UNC paths, etc.) must not abort the whole
            // scan — skip it instead.
            let children =
                scan_dir_tree_inner(&path, show_all_files, ancestors).unwrap_or_default();
            // Only include directories that contain files (directly or nested)
            if !children.is_empty() {
                let (modified, created, size) = get_file_metadata(&path);
                entries.push(FileEntry {
                    name,
                    path: path.to_string_lossy().to_string(),
                    is_dir: true,
                    children: Some(children),
                    modified,
                    created,
                    size,
                });
            }
        } else if show_all_files || is_listed_file(&name) {
            let (modified, created, size) = get_file_metadata(&path);
            entries.push(FileEntry {
                name,
                path: path.to_string_lossy().to_string(),
                is_dir: false,
                children: None,
                modified,
                created,
                size,
            });
        }
    }

    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

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
        assert!(entries[0].modified.is_some());
        assert!(entries[0].size.is_some());
    }

    #[test]
    fn scan_dir_tree_show_all_files() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("note.md"), "# Hello").unwrap();
        fs::write(tmp.path().join("readme.txt"), "text").unwrap();
        fs::write(tmp.path().join("data.json"), "{}").unwrap();

        // Default: only .md files
        let entries = scan_dir_tree(tmp.path()).unwrap();
        assert_eq!(entries.len(), 1);

        // show_all_files: all files
        let entries = scan_dir_tree_filtered(tmp.path(), true).unwrap();
        assert_eq!(entries.len(), 3);
    }

    #[test]
    fn scan_dir_tree_finds_qmd_files() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("report.qmd"), "---\ntitle: x\n---").unwrap();
        fs::write(tmp.path().join("readme.txt"), "ignored").unwrap();

        let entries = scan_dir_tree(tmp.path()).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "report.qmd");
        assert!(!entries[0].is_dir);
    }

    /// Regression: a symlink to a directory used to be classified as a file
    /// (DirEntry::file_type never follows links) and dropped by the extension
    /// filter, so whole linked folders vanished from the filer.
    #[cfg(unix)]
    #[test]
    fn scan_dir_tree_follows_symlinked_dirs() {
        use std::os::unix::fs::symlink;
        let tmp = TempDir::new().unwrap();
        let real = tmp.path().join("real");
        fs::create_dir(&real).unwrap();
        fs::write(real.join("note.md"), "# linked").unwrap();
        fs::write(real.join("config.yaml"), "a: 1").unwrap();
        let vault = tmp.path().join("vault");
        fs::create_dir(&vault).unwrap();
        symlink(&real, vault.join("linked")).unwrap();

        let entries = scan_dir_tree(&vault).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "linked");
        assert!(entries[0].is_dir);
        let children = entries[0].children.as_ref().unwrap();
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].name, "note.md");

        // show_all_files applies inside the linked folder too
        let entries = scan_dir_tree_filtered(&vault, true).unwrap();
        let children = entries[0].children.as_ref().unwrap();
        let names: Vec<&str> = children.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["config.yaml", "note.md"]);
    }

    #[cfg(unix)]
    #[test]
    fn scan_dir_tree_symlinked_dirs_sort_with_dirs() {
        use std::os::unix::fs::symlink;
        let tmp = TempDir::new().unwrap();
        let real = tmp.path().join("real");
        fs::create_dir(&real).unwrap();
        fs::write(real.join("x.md"), "").unwrap();
        let vault = tmp.path().join("vault");
        fs::create_dir(&vault).unwrap();
        fs::write(vault.join("a.md"), "").unwrap();
        symlink(&real, vault.join("zlink")).unwrap();

        let entries = scan_dir_tree(&vault).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["zlink", "a.md"]);
    }

    #[cfg(unix)]
    #[test]
    fn scan_dir_tree_symlinked_file_is_listed_by_extension() {
        use std::os::unix::fs::symlink;
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("target.txt"), "x").unwrap();
        let vault = tmp.path().join("vault");
        fs::create_dir(&vault).unwrap();
        symlink(tmp.path().join("target.txt"), vault.join("note.md")).unwrap();
        symlink(tmp.path().join("target.txt"), vault.join("data.txt")).unwrap();

        let entries = scan_dir_tree(&vault).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["note.md"]);
        assert!(!entries[0].is_dir);
    }

    #[cfg(unix)]
    #[test]
    fn scan_dir_tree_symlink_loop_terminates() {
        use std::os::unix::fs::symlink;
        let tmp = TempDir::new().unwrap();
        let a = tmp.path().join("a");
        fs::create_dir(&a).unwrap();
        fs::write(a.join("note.md"), "").unwrap();
        // a/loop -> a  (cycle) and vault/up -> vault (self-cycle)
        symlink(&a, a.join("loop")).unwrap();
        symlink(tmp.path(), tmp.path().join("up")).unwrap();

        let entries = scan_dir_tree(tmp.path()).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        // "up" points at an ancestor -> scanned as empty -> excluded.
        assert_eq!(names, vec!["a"]);
        let children = entries[0].children.as_ref().unwrap();
        let names: Vec<&str> = children.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["note.md"]);
    }

    #[cfg(unix)]
    #[test]
    fn scan_dir_tree_dangling_symlink_is_skipped() {
        use std::os::unix::fs::symlink;
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("note.md"), "").unwrap();
        symlink(tmp.path().join("missing"), tmp.path().join("dangling")).unwrap();
        symlink(
            tmp.path().join("missing.md"),
            tmp.path().join("dangling.md"),
        )
        .unwrap();

        // Must not error; the .md-named dangling link is listed like a file
        // (opening it will surface the real error), the other is dropped.
        let entries = scan_dir_tree_filtered(tmp.path(), false).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["dangling.md", "note.md"]);
    }

    #[test]
    fn scan_dir_tree_lists_plantuml_and_markdown_variants() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("a.puml"), "@startuml\n@enduml").unwrap();
        fs::write(tmp.path().join("b.uml"), "@startuml\n@enduml").unwrap();
        fs::write(tmp.path().join("c.markdown"), "# x").unwrap();
        fs::write(tmp.path().join("d.png"), "binary").unwrap();
        fs::write(tmp.path().join("ignored.zip"), "binary").unwrap();

        let names: Vec<String> = scan_dir_tree(tmp.path())
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert!(names.contains(&"a.puml".to_string()));
        assert!(names.contains(&"b.uml".to_string()));
        assert!(names.contains(&"c.markdown".to_string()));
        assert!(names.contains(&"d.png".to_string()));
        assert!(!names.contains(&"ignored.zip".to_string()));
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

    #[test]
    fn temp_files_are_hidden_from_scan() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("notes.md"), "# Notes").unwrap();
        fs::write(tmp.path().join(".~notes.md.tmp"), "unsaved draft").unwrap();

        let entries = scan_dir_tree(tmp.path()).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "notes.md");
    }

    #[test]
    fn write_file_creates_parents_and_read_file_roundtrips() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("a/b/c.md");
        let ps = p.to_string_lossy().to_string();
        write_file(&ps, "hello").unwrap();
        assert_eq!(read_file(&ps).unwrap(), "hello");
        assert!(read_file(&tmp.path().join("missing.md").to_string_lossy()).is_err());
    }

    #[test]
    fn create_and_rename_refuse_to_clobber() {
        let tmp = TempDir::new().unwrap();
        let a = tmp.path().join("a.md").to_string_lossy().to_string();
        let b = tmp.path().join("b.md").to_string_lossy().to_string();
        create_file(&a).unwrap();
        assert!(create_file(&a).is_err());
        create_file(&b).unwrap();
        assert!(rename_path(&a, &b).is_err());
        assert!(rename_path("", &b).is_err());
        let d = tmp.path().join("dir").to_string_lossy().to_string();
        create_directory(&d).unwrap();
        assert!(create_directory(&d).is_err());
    }
}
