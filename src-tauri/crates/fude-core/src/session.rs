//! `session.json`: which tabs, vault and layout to restore on launch.

use crate::paths::{config_dir, ensure_config_dir};
use serde::{Deserialize, Serialize};
use std::fs;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TabInfo {
    pub path: String,
    pub cursor_line: usize,
    pub cursor_col: usize,
    pub scroll_top: f64,
    /// Per-tab view mode ("split" | "editor" | "preview"). Defaults to "split"
    /// so sessions written by older versions deserialize cleanly.
    #[serde(default = "default_view_mode")]
    pub view_mode: String,
}

fn default_view_mode() -> String {
    "split".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaneInfo {
    pub tab_id: Option<String>,
    pub size_percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaneLayout {
    pub direction: String,
    pub panes: Vec<PaneInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub open_tabs: Vec<TabInfo>,
    pub active_tab: usize,
    pub vault_path: Option<String>,
    pub view_mode: String,
    pub sidebar_visible: bool,
    pub pane_layout: Option<PaneLayout>,
}

impl Default for Session {
    fn default() -> Self {
        Session {
            open_tabs: Vec::new(),
            active_tab: 0,
            vault_path: None,
            view_mode: "split".to_string(),
            sidebar_visible: true,
            pane_layout: None,
        }
    }
}

pub fn load_session() -> Result<Option<Session>, String> {
    let path = config_dir()?.join("session.json");
    if !path.exists() {
        return Ok(None);
    }
    let content =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read session file: {}", e))?;
    let session: Session = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse session file: {}", e))?;
    Ok(Some(session))
}

pub fn save_session(session: &Session) -> Result<(), String> {
    let dir = ensure_config_dir()?;
    let path = dir.join("session.json");
    let content = serde_json::to_string_pretty(session)
        .map_err(|e| format!("Failed to serialize session: {}", e))?;
    fs::write(&path, content).map_err(|e| format!("Failed to write session file: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_default_values() {
        let session = Session::default();
        assert!(session.open_tabs.is_empty());
        assert_eq!(session.active_tab, 0);
        assert!(session.vault_path.is_none());
        assert_eq!(session.view_mode, "split");
        assert!(session.sidebar_visible);
        assert!(session.pane_layout.is_none());
    }

    #[test]
    fn session_serialization_roundtrip() {
        let session = Session {
            open_tabs: vec![TabInfo {
                path: "/tmp/test.md".to_string(),
                cursor_line: 10,
                cursor_col: 5,
                scroll_top: 120.5,
                view_mode: "preview".to_string(),
            }],
            active_tab: 0,
            vault_path: Some("/home/user/vault".to_string()),
            view_mode: "editor".to_string(),
            sidebar_visible: false,
            pane_layout: Some(PaneLayout {
                direction: "horizontal".to_string(),
                panes: vec![PaneInfo {
                    tab_id: Some("tab-1".to_string()),
                    size_percent: 50.0,
                }],
            }),
        };

        let json = serde_json::to_string(&session).unwrap();
        let restored: Session = serde_json::from_str(&json).unwrap();

        assert_eq!(restored.open_tabs.len(), 1);
        assert_eq!(restored.open_tabs[0].path, "/tmp/test.md");
        assert_eq!(restored.open_tabs[0].cursor_line, 10);
        assert_eq!(restored.open_tabs[0].view_mode, "preview");
        assert_eq!(restored.active_tab, 0);
        assert_eq!(restored.vault_path.as_deref(), Some("/home/user/vault"));
        assert_eq!(restored.view_mode, "editor");
        assert!(!restored.sidebar_visible);
        let layout = restored.pane_layout.unwrap();
        assert_eq!(layout.direction, "horizontal");
        assert_eq!(layout.panes.len(), 1);
    }

    #[test]
    fn tab_info_view_mode_defaults_when_absent() {
        // Sessions written by older versions have no `view_mode` on tabs.
        let json = r#"{"path":"/tmp/old.md","cursor_line":0,"cursor_col":0,"scroll_top":0.0}"#;
        let tab: TabInfo = serde_json::from_str(json).unwrap();
        assert_eq!(tab.view_mode, "split");
    }

    #[test]
    fn tab_info_view_mode_roundtrip() {
        let json = r#"{"path":"/tmp/n.md","cursor_line":0,"cursor_col":0,"scroll_top":0.0,"view_mode":"editor"}"#;
        let tab: TabInfo = serde_json::from_str(json).unwrap();
        assert_eq!(tab.view_mode, "editor");
    }
}
