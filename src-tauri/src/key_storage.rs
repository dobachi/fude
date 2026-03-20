use std::fs;
use std::path::PathBuf;

const SERVICE_NAME: &str = "fude-markdown-editor";
const KEY_NAME: &str = "openrouter-api-key";

pub trait KeyStorage: Send + Sync {
    fn get_key(&self) -> Result<Option<String>, String>;
    fn set_key(&self, key: &str) -> Result<(), String>;
    fn delete_key(&self) -> Result<(), String>;
    fn storage_type(&self) -> &'static str;
}

// ─── Keyring Storage ──────────────────────────────────────

pub struct KeyringStorage;

impl KeyStorage for KeyringStorage {
    fn get_key(&self) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(SERVICE_NAME, KEY_NAME)
            .map_err(|e| format!("Keyring error: {}", e))?;
        match entry.get_password() {
            Ok(key) => Ok(Some(key)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("Keyring get error: {}", e)),
        }
    }

    fn set_key(&self, key: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(SERVICE_NAME, KEY_NAME)
            .map_err(|e| format!("Keyring error: {}", e))?;
        entry
            .set_password(key)
            .map_err(|e| format!("Keyring set error: {}", e))
    }

    fn delete_key(&self) -> Result<(), String> {
        let entry = keyring::Entry::new(SERVICE_NAME, KEY_NAME)
            .map_err(|e| format!("Keyring error: {}", e))?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("Keyring delete error: {}", e)),
        }
    }

    fn storage_type(&self) -> &'static str {
        "keychain"
    }
}

// ─── Config Fallback Storage ──────────────────────────────

pub struct ConfigFallbackStorage {
    config_path: PathBuf,
}

impl ConfigFallbackStorage {
    pub fn new(config_path: PathBuf) -> Self {
        Self { config_path }
    }
}

impl KeyStorage for ConfigFallbackStorage {
    fn get_key(&self) -> Result<Option<String>, String> {
        if !self.config_path.exists() {
            return Ok(None);
        }
        let content = fs::read_to_string(&self.config_path)
            .map_err(|e| format!("Failed to read config: {}", e))?;
        let value: serde_json::Value = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse config: {}", e))?;
        match value.get("openrouter_api_key").and_then(|v| v.as_str()) {
            Some(key) if !key.is_empty() => Ok(Some(key.to_string())),
            _ => Ok(None),
        }
    }

    fn set_key(&self, key: &str) -> Result<(), String> {
        let mut value: serde_json::Value = if self.config_path.exists() {
            let content = fs::read_to_string(&self.config_path)
                .map_err(|e| format!("Failed to read config: {}", e))?;
            serde_json::from_str(&content)
                .map_err(|e| format!("Failed to parse config: {}", e))?
        } else {
            serde_json::json!({})
        };
        value["openrouter_api_key"] = serde_json::Value::String(key.to_string());
        let content = serde_json::to_string_pretty(&value)
            .map_err(|e| format!("Failed to serialize config: {}", e))?;
        fs::write(&self.config_path, content)
            .map_err(|e| format!("Failed to write config: {}", e))?;
        set_file_permissions(&self.config_path)?;
        Ok(())
    }

    fn delete_key(&self) -> Result<(), String> {
        if !self.config_path.exists() {
            return Ok(());
        }
        let content = fs::read_to_string(&self.config_path)
            .map_err(|e| format!("Failed to read config: {}", e))?;
        let mut value: serde_json::Value = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse config: {}", e))?;
        value["openrouter_api_key"] = serde_json::Value::Null;
        let content = serde_json::to_string_pretty(&value)
            .map_err(|e| format!("Failed to serialize config: {}", e))?;
        fs::write(&self.config_path, content)
            .map_err(|e| format!("Failed to write config: {}", e))
    }

    fn storage_type(&self) -> &'static str {
        "config_file"
    }
}

// ─── File Permissions ─────────────────────────────────────

#[cfg(unix)]
pub fn set_file_permissions(path: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let perms = fs::Permissions::from_mode(0o600);
    fs::set_permissions(path, perms)
        .map_err(|e| format!("Failed to set file permissions: {}", e))
}

#[cfg(not(unix))]
pub fn set_file_permissions(_path: &std::path::Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
pub fn set_dir_permissions(path: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let perms = fs::Permissions::from_mode(0o700);
    fs::set_permissions(path, perms)
        .map_err(|e| format!("Failed to set directory permissions: {}", e))
}

#[cfg(not(unix))]
pub fn set_dir_permissions(_path: &std::path::Path) -> Result<(), String> {
    Ok(())
}

// ─── Factory ──────────────────────────────────────────────

pub fn create_storage(config_path: PathBuf) -> Box<dyn KeyStorage> {
    // Probe keyring availability
    let probe = keyring::Entry::new(SERVICE_NAME, "probe-test");
    match probe {
        Ok(entry) => {
            // Try a set/get/delete cycle to verify keyring works
            match entry.set_password("probe") {
                Ok(()) => {
                    let _ = entry.delete_credential();
                    Box::new(KeyringStorage)
                }
                Err(_) => Box::new(ConfigFallbackStorage::new(config_path)),
            }
        }
        Err(_) => Box::new(ConfigFallbackStorage::new(config_path)),
    }
}

// ─── Tests ────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn config_fallback_set_and_get() {
        let tmp = TempDir::new().unwrap();
        let config_path = tmp.path().join("config.json");
        fs::write(&config_path, "{}").unwrap();

        let storage = ConfigFallbackStorage::new(config_path);
        assert!(storage.get_key().unwrap().is_none());

        storage.set_key("sk-test-123").unwrap();
        assert_eq!(storage.get_key().unwrap().as_deref(), Some("sk-test-123"));
    }

    #[test]
    fn config_fallback_delete() {
        let tmp = TempDir::new().unwrap();
        let config_path = tmp.path().join("config.json");
        fs::write(
            &config_path,
            r#"{"openrouter_api_key":"sk-old","theme":"dark"}"#,
        )
        .unwrap();

        let storage = ConfigFallbackStorage::new(config_path.clone());
        storage.delete_key().unwrap();

        let content = fs::read_to_string(&config_path).unwrap();
        let v: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert!(v["openrouter_api_key"].is_null());
        // Other fields preserved
        assert_eq!(v["theme"].as_str(), Some("dark"));
    }

    #[test]
    fn config_fallback_get_nonexistent() {
        let tmp = TempDir::new().unwrap();
        let config_path = tmp.path().join("no_such_file.json");
        let storage = ConfigFallbackStorage::new(config_path);
        assert!(storage.get_key().unwrap().is_none());
    }

    #[test]
    fn config_fallback_get_empty_key() {
        let tmp = TempDir::new().unwrap();
        let config_path = tmp.path().join("config.json");
        fs::write(&config_path, r#"{"openrouter_api_key":""}"#).unwrap();

        let storage = ConfigFallbackStorage::new(config_path);
        assert!(storage.get_key().unwrap().is_none());
    }

    #[test]
    fn config_fallback_storage_type() {
        let tmp = TempDir::new().unwrap();
        let storage = ConfigFallbackStorage::new(tmp.path().join("config.json"));
        assert_eq!(storage.storage_type(), "config_file");
    }

    #[test]
    fn keyring_storage_type() {
        let storage = KeyringStorage;
        assert_eq!(storage.storage_type(), "keychain");
    }

    #[cfg(unix)]
    #[test]
    fn file_permissions_set_to_0600() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new().unwrap();
        let file = tmp.path().join("secret.json");
        fs::write(&file, "{}").unwrap();
        set_file_permissions(&file).unwrap();
        let mode = fs::metadata(&file).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn dir_permissions_set_to_0700() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("secret_dir");
        fs::create_dir(&dir).unwrap();
        set_dir_permissions(&dir).unwrap();
        let mode = fs::metadata(&dir).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
    }
}
