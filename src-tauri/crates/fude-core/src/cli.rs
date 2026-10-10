//! Command-line helpers shared by the desktop app and the CLI.

use std::path::{Path, PathBuf};

/// Resolve a (possibly relative) CLI path argument to an absolute path string,
/// using `base` (the launch working directory) for relative paths. On Unix the
/// result is canonicalized when the target exists; otherwise the lexical join is
/// returned. On Windows the lexical join is used to avoid `\\?\` verbatim paths.
pub fn resolve_cli_path(path: &str, base: Option<PathBuf>) -> String {
    let p = Path::new(path);
    let joined = if p.is_absolute() {
        p.to_path_buf()
    } else {
        let base = base
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_else(|| PathBuf::from("."));
        base.join(p)
    };

    #[cfg(not(windows))]
    {
        if let Ok(abs) = joined.canonicalize() {
            return abs.to_string_lossy().to_string();
        }
    }
    joined.to_string_lossy().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[cfg(not(windows))]
    #[test]
    fn resolve_cli_path_keeps_absolute_unchanged() {
        // Nonexistent absolute path: canonicalize fails, returned as-is.
        let r = resolve_cli_path("/nonexistent/abs/path.md", Some(PathBuf::from("/base")));
        assert_eq!(r, "/nonexistent/abs/path.md");
    }

    #[cfg(not(windows))]
    #[test]
    fn resolve_cli_path_joins_relative_to_base() {
        // Nonexistent relative path: canonicalize fails, returns lexical join.
        let r = resolve_cli_path("notes/a.md", Some(PathBuf::from("/work/dir")));
        assert_eq!(r, "/work/dir/notes/a.md");
    }

    #[cfg(not(windows))]
    #[test]
    fn resolve_cli_path_canonicalizes_existing_relative_dir() {
        let tmp = TempDir::new().unwrap();
        let sub = tmp.path().join("docs");
        fs::create_dir(&sub).unwrap();
        let r = resolve_cli_path("docs", Some(tmp.path().to_path_buf()));
        // Result is absolute and points at the existing subdirectory.
        assert!(Path::new(&r).is_absolute());
        assert_eq!(
            Path::new(&r).canonicalize().unwrap(),
            sub.canonicalize().unwrap()
        );
    }
}
