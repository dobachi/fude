//! Command-line helpers shared by the desktop app and the CLI.

use std::path::{Path, PathBuf};

/// Resolve a (possibly relative) CLI path argument to an absolute path string,
/// using `base` (the launch working directory) for relative paths. On Unix the
/// result is canonicalized when the target exists; otherwise the lexical join is
/// returned. On Windows the lexical join is used to avoid `\\?\` verbatim paths.
pub fn resolve_cli_path(path: &str, base: Option<PathBuf>) -> String {
    // A remote place (`ssh://host/path`, as Tana hands over) is not a local
    // path: joining it to the working directory would mangle it.
    if is_remote_uri(path) {
        return path.to_string();
    }
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

/// True for a remote place given as a URL: `ssh://`, `sftp://` or `remote://`
/// (any case). The front end opens these over ssh instead of from disk.
pub fn is_remote_uri(path: &str) -> bool {
    let lower = path.trim_start().to_ascii_lowercase();
    ["ssh://", "sftp://", "remote://"]
        .iter()
        .any(|scheme| lower.starts_with(scheme))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn resolve_cli_path_keeps_remote_uris_unchanged() {
        let base = Some(PathBuf::from("/work"));
        for uri in [
            "ssh://k16/etc/hosts",
            "SFTP://h/x.md",
            "remote://h/~/a b.md",
        ] {
            assert_eq!(resolve_cli_path(uri, base.clone()), uri);
        }
    }

    #[test]
    fn is_remote_uri_only_matches_url_schemes() {
        assert!(is_remote_uri("ssh://h/p"));
        assert!(is_remote_uri("sftp://h/p"));
        assert!(is_remote_uri("Remote://h/p"));
        assert!(!is_remote_uri("/tmp/ssh://x"));
        assert!(!is_remote_uri("k16:/etc/hosts"));
        assert!(!is_remote_uri("C:/Users/a.md"));
        assert!(!is_remote_uri("notes.md"));
    }

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
