//! `config.json`: user settings shared by every Fude front end.

use crate::paths::{config_dir, ensure_config_dir, set_dir_permissions, set_file_permissions};
use serde::{Deserialize, Serialize};
use std::fs;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Features {
    pub ai_copilot: bool,
    pub diff_highlight: bool,
    pub code_highlight: bool,
    pub source_code_mode: bool,
    pub plantuml_preview: bool,
    pub mermaid_preview: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub theme: String,
    pub features: Features,
    pub font_size: u32,
    /// App (chrome) font size, independent of the editor `font_size`.
    pub ui_font_size: u32,
    /// Deprecated: use `key_mode`. Kept for backward compatibility.
    pub vim_mode: bool,
    /// "normal" | "vim" | "emacs"
    pub key_mode: Option<String>,
    pub openrouter_api_key: Option<String>,
    /// Global default model used by any AI feature that doesn't have a
    /// per-task override below. Falls back to a hardcoded default in JS
    /// when unset.
    pub ai_model: Option<String>,
    /// Per-task overrides. When None, the feature uses `ai_model`.
    #[serde(default)]
    pub ai_model_chat: Option<String>,
    #[serde(default)]
    pub ai_model_composer: Option<String>,
    #[serde(default)]
    pub ai_model_inline: Option<String>,
    pub sidebar_sort: Option<String>,
    pub sidebar_show_all_files: Option<bool>,
}

/// What the front end receives: `Config` with defaults applied and the API
/// key replaced by whether one exists (and where it lives).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigResponse {
    pub theme: String,
    pub features: Features,
    pub font_size: u32,
    pub ui_font_size: u32,
    pub key_mode: String,
    pub has_api_key: bool,
    pub api_key_storage: String,
    pub ai_model: Option<String>,
    pub ai_model_chat: Option<String>,
    pub ai_model_composer: Option<String>,
    pub ai_model_inline: Option<String>,
    pub sidebar_sort: String,
    pub sidebar_show_all_files: bool,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            theme: "dark".to_string(),
            features: Features::default(),
            font_size: 14,
            ui_font_size: 14,
            vim_mode: false,
            key_mode: None,
            openrouter_api_key: None,
            ai_model: None,
            ai_model_chat: None,
            ai_model_composer: None,
            ai_model_inline: None,
            sidebar_sort: None,
            sidebar_show_all_files: None,
        }
    }
}

impl Default for Features {
    fn default() -> Self {
        Features {
            ai_copilot: false,
            diff_highlight: true,
            code_highlight: false,
            source_code_mode: false,
            plantuml_preview: false,
            mermaid_preview: false,
        }
    }
}

impl Config {
    /// The effective key mode, migrating the legacy `vim_mode: bool`.
    pub fn effective_key_mode(&self) -> String {
        self.key_mode.clone().unwrap_or_else(|| {
            if self.vim_mode {
                "vim".to_string()
            } else {
                "normal".to_string()
            }
        })
    }
}

pub fn load_config() -> Result<Config, String> {
    let path = config_dir()?.join("config.json");
    if !path.exists() {
        return Ok(Config::default());
    }
    let content =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read config file: {}", e))?;
    let config: Config = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse config file: {}", e))?;
    Ok(config)
}

/// Build the front-end view of `config`. The caller supplies what it knows
/// about the API key, since key storage is a desktop-app concern.
pub fn config_response(config: Config, has_api_key: bool, storage_type: &str) -> ConfigResponse {
    let key_mode = config.effective_key_mode();
    ConfigResponse {
        theme: config.theme,
        features: config.features,
        font_size: config.font_size,
        ui_font_size: config.ui_font_size,
        key_mode,
        has_api_key,
        api_key_storage: storage_type.to_string(),
        ai_model: config.ai_model,
        ai_model_chat: config.ai_model_chat,
        ai_model_composer: config.ai_model_composer,
        ai_model_inline: config.ai_model_inline,
        sidebar_sort: config
            .sidebar_sort
            .unwrap_or_else(|| "name_asc".to_string()),
        sidebar_show_all_files: config.sidebar_show_all_files.unwrap_or(false),
    }
}

/// Write `config`, carrying forward whatever API key is already on disk.
///
/// Key management is the exclusive responsibility of the desktop app's
/// set_api_key / delete_api_key. save_config must never read, write, or
/// "preserve" the key through key storage — earlier attempts to be helpful
/// here ended up routing the key back through a broken keyring and
/// clobbering the copy that set_api_key had just written. Always carry
/// forward whatever is already on disk so this is a no-op for the key field.
pub fn save_config(config: Config) -> Result<(), String> {
    let dir = ensure_config_dir()?;
    let path = dir.join("config.json");

    let mut config_to_save = config;
    config_to_save.openrouter_api_key = load_config()
        .ok()
        .and_then(|existing| existing.openrouter_api_key);

    let content = serde_json::to_string_pretty(&config_to_save)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    fs::write(&path, &content).map_err(|e| format!("Failed to write config file: {}", e))?;

    // Strengthen file permissions
    let _ = set_file_permissions(&path);
    let _ = set_dir_permissions(&dir);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_default_values() {
        let config = Config::default();
        assert_eq!(config.theme, "dark");
        assert_eq!(config.font_size, 14);
        assert!(!config.vim_mode);
        assert!(!config.features.ai_copilot);
        assert!(config.features.diff_highlight);
        assert!(config.openrouter_api_key.is_none());
        assert!(config.ai_model.is_none());
        assert!(config.sidebar_sort.is_none());
        assert!(config.sidebar_show_all_files.is_none());
    }

    #[test]
    fn config_serialization_roundtrip() {
        let config = Config {
            theme: "light".to_string(),
            features: Features {
                ai_copilot: true,
                diff_highlight: false,
                code_highlight: true,
                source_code_mode: true,
                plantuml_preview: true,
                mermaid_preview: true,
            },
            font_size: 18,
            ui_font_size: 16,
            vim_mode: true,
            key_mode: Some("vim".to_string()),
            openrouter_api_key: Some("sk-test-key".to_string()),
            ai_model: Some("openai/gpt-4o".to_string()),
            ai_model_chat: Some("anthropic/claude-sonnet-4.5".to_string()),
            ai_model_composer: None,
            ai_model_inline: Some("google/gemini-2.5-flash".to_string()),
            sidebar_sort: Some("modified_desc".to_string()),
            sidebar_show_all_files: Some(true),
        };

        let json = serde_json::to_string(&config).unwrap();
        let restored: Config = serde_json::from_str(&json).unwrap();

        assert_eq!(restored.theme, "light");
        assert!(restored.features.ai_copilot);
        assert!(!restored.features.diff_highlight);
        assert!(restored.features.mermaid_preview);
        assert_eq!(restored.font_size, 18);
        assert_eq!(restored.ui_font_size, 16);
        assert!(restored.vim_mode);
        assert_eq!(restored.openrouter_api_key.as_deref(), Some("sk-test-key"));
        assert_eq!(restored.ai_model.as_deref(), Some("openai/gpt-4o"));
        assert_eq!(
            restored.ai_model_chat.as_deref(),
            Some("anthropic/claude-sonnet-4.5")
        );
        assert!(restored.ai_model_composer.is_none());
        assert_eq!(
            restored.ai_model_inline.as_deref(),
            Some("google/gemini-2.5-flash")
        );
        assert_eq!(restored.sidebar_sort.as_deref(), Some("modified_desc"));
        assert_eq!(restored.sidebar_show_all_files, Some(true));
    }

    #[test]
    fn config_deserializes_with_missing_fields() {
        // Old config files may lack newer fields like ai_model
        let json = r#"{"theme":"dark","font_size":14,"vim_mode":false}"#;
        let config: Config = serde_json::from_str(json).unwrap();
        assert_eq!(config.theme, "dark");
        assert!(!config.features.ai_copilot); // default
        assert!(config.features.diff_highlight); // default
        assert!(config.openrouter_api_key.is_none()); // default
        assert!(config.ai_model.is_none()); // default
        assert!(config.sidebar_sort.is_none()); // default
        assert!(config.sidebar_show_all_files.is_none()); // default
    }

    #[test]
    fn key_mode_migrates_legacy_vim_flag() {
        let mut c = Config::default();
        assert_eq!(c.effective_key_mode(), "normal");
        c.vim_mode = true;
        assert_eq!(c.effective_key_mode(), "vim");
        c.key_mode = Some("emacs".into());
        assert_eq!(c.effective_key_mode(), "emacs");
    }

    #[test]
    fn config_response_applies_defaults_and_key_info() {
        let r = config_response(Config::default(), true, "keychain");
        assert_eq!(r.key_mode, "normal");
        assert!(r.has_api_key);
        assert_eq!(r.api_key_storage, "keychain");
        assert_eq!(r.sidebar_sort, "name_asc");
        assert!(!r.sidebar_show_all_files);
    }
}
