//! Autosave temp files (`~/.config/fude/tmp/`) for crash recovery.

use crate::paths::temp_file_path;
use serde::{Deserialize, Serialize};
use std::fs;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TempFileInfo {
    pub original_path: String,
    pub temp_path: String,
    pub modified: String,
}

pub fn write_temp_file(path: &str, content: &str) -> Result<(), String> {
    let temp_path = temp_file_path(path)?;
    fs::write(&temp_path, content)
        .map_err(|e| format!("Failed to write temp file '{}': {}", temp_path.display(), e))
}

pub fn delete_temp_file(path: &str) -> Result<(), String> {
    let temp_path = temp_file_path(path)?;
    if temp_path.exists() {
        fs::remove_file(&temp_path).map_err(|e| {
            format!(
                "Failed to delete temp file '{}': {}",
                temp_path.display(),
                e
            )
        })?;
    }
    Ok(())
}

/// Which of `paths` have an autosave file waiting (and when it was written).
pub fn check_temp_files(paths: Vec<String>) -> Result<Vec<TempFileInfo>, String> {
    let mut results = Vec::new();

    for path in paths {
        let temp_path = match temp_file_path(&path) {
            Ok(p) => p,
            Err(_) => continue,
        };

        if temp_path.exists() {
            let metadata = fs::metadata(&temp_path)
                .map_err(|e| format!("Failed to read temp file metadata: {}", e))?;
            let modified = metadata
                .modified()
                .map(|t| {
                    let duration = t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
                    format!("{}", duration.as_millis())
                })
                .unwrap_or_else(|_| "unknown".to_string());

            results.push(TempFileInfo {
                original_path: path,
                temp_path: temp_path.to_string_lossy().to_string(),
                modified,
            });
        }
    }

    Ok(results)
}
