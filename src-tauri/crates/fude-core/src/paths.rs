//! Where Fude keeps its own files: `~/.config/fude` (config, session, the
//! autosave temp files, the IPC socket).

use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

pub fn config_dir() -> Result<PathBuf, String> {
    let base =
        dirs::config_dir().ok_or_else(|| "Could not determine config directory".to_string())?;
    Ok(base.join("fude"))
}

pub fn ensure_config_dir() -> Result<PathBuf, String> {
    let dir = config_dir()?;
    if !dir.exists() {
        fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create config directory: {}", e))?;
    }
    Ok(dir)
}

pub fn temp_dir() -> Result<PathBuf, String> {
    let dir = config_dir()?.join("tmp");
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create temp directory: {}", e))?;
    }
    Ok(dir)
}

/// The autosave file for `original_path`: `<hash>_<file name>` inside
/// [`temp_dir`]. Deterministic, so crash recovery finds it again.
pub fn temp_file_path(original_path: &str) -> Result<PathBuf, String> {
    let dir = temp_dir()?;
    let mut hasher = DefaultHasher::new();
    original_path.hash(&mut hasher);
    let hash = hasher.finish();
    let file_name = Path::new(original_path)
        .file_name()
        .ok_or_else(|| "Invalid file path".to_string())?
        .to_string_lossy();
    let temp_name = format!("{:x}_{}", hash, file_name);
    Ok(dir.join(temp_name))
}

// ─── File Permissions ─────────────────────────────────────

#[cfg(unix)]
pub fn set_file_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let perms = fs::Permissions::from_mode(0o600);
    fs::set_permissions(path, perms).map_err(|e| format!("Failed to set file permissions: {}", e))
}

#[cfg(not(unix))]
pub fn set_file_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
pub fn set_dir_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let perms = fs::Permissions::from_mode(0o700);
    fs::set_permissions(path, perms)
        .map_err(|e| format!("Failed to set directory permissions: {}", e))
}

#[cfg(not(unix))]
pub fn set_dir_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- Temp file naming convention ---

    #[test]
    fn temp_file_path_is_in_config_dir() {
        // Temp files should be stored in ~/.config/fude/tmp/
        let path = temp_file_path("/home/user/docs/notes.md").unwrap();
        let path_str = path.to_string_lossy();
        assert!(path_str.contains("fude"));
        assert!(path_str.contains("tmp"));
        assert!(path_str.contains("notes.md"));
    }

    #[test]
    fn temp_file_path_is_deterministic() {
        let path1 = temp_file_path("/home/user/docs/notes.md").unwrap();
        let path2 = temp_file_path("/home/user/docs/notes.md").unwrap();
        assert_eq!(path1, path2);
    }

    #[test]
    fn temp_file_path_differs_for_different_files() {
        let path1 = temp_file_path("/home/user/docs/notes.md").unwrap();
        let path2 = temp_file_path("/home/user/docs/other.md").unwrap();
        assert_ne!(path1, path2);
    }
}
