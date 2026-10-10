//! Flat directory listing for the folder picker.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

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

pub fn list_directory(dir: &Path) -> Result<Vec<BrowseEntry>, String> {
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

/// List `path` (the home directory when empty) with its parent.
pub fn browse_dir(path: &str) -> Result<BrowseResult, String> {
    let dir = if path.is_empty() {
        dirs::home_dir().ok_or_else(|| "Could not determine home directory".to_string())?
    } else {
        PathBuf::from(path)
    };

    if !dir.is_dir() {
        return Err(format!("'{}' is not a directory", dir.display()));
    }

    let parent = dir.parent().unwrap_or(&dir).to_string_lossy().to_string();

    let entries = list_directory(&dir)?;

    Ok(BrowseResult {
        current: dir.to_string_lossy().to_string(),
        parent,
        entries,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

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
    fn browse_dir_rejects_a_file_and_reports_parent() {
        let tmp = TempDir::new().unwrap();
        let file = tmp.path().join("f.txt");
        fs::write(&file, "x").unwrap();
        assert!(browse_dir(&file.to_string_lossy()).is_err());
        let r = browse_dir(&tmp.path().to_string_lossy()).unwrap();
        assert_eq!(r.parent, tmp.path().parent().unwrap().to_string_lossy());
        assert_eq!(r.entries.len(), 1);
    }
}
