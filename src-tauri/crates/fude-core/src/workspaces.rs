//! `workspaces.json`: named workspaces, each with its own saved session and
//! its own choice of what that session keeps.
//!
//! The front end owns the logic (switching, filtering what is kept; see
//! src/js/core/workspaces.js). This file only stores what it is given, typed
//! so a broken file is reported instead of silently restoring garbage.
//! `session.json` is still written alongside, holding the active workspace's
//! session, so an older Fude keeps finding the session it expects.

use crate::paths::{config_dir, ensure_config_dir};
use crate::session::Session;
use serde::{Deserialize, Serialize};
use std::fs;

fn yes() -> bool {
    true
}

/// What a workspace's session keeps. Everything is kept unless switched off,
/// which is also what a workspace written before a field existed gets.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkspaceKeep {
    #[serde(default = "yes")]
    pub folder: bool,
    #[serde(default = "yes")]
    pub tabs: bool,
    #[serde(default = "yes")]
    pub view_mode: bool,
    #[serde(default = "yes")]
    pub sidebar: bool,
}

impl Default for WorkspaceKeep {
    fn default() -> Self {
        WorkspaceKeep {
            folder: true,
            tabs: true,
            view_mode: true,
            sidebar: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub name: String,
    #[serde(default)]
    pub keep: WorkspaceKeep,
    #[serde(default)]
    pub session: Option<Session>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceStore {
    pub active: String,
    #[serde(default)]
    pub workspaces: Vec<Workspace>,
}

const FILE: &str = "workspaces.json";

pub fn load_workspaces() -> Result<Option<WorkspaceStore>, String> {
    let path = config_dir()?.join(FILE);
    if !path.exists() {
        return Ok(None);
    }
    let content =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read workspaces file: {}", e))?;
    parse_workspaces(&content).map(Some)
}

pub fn parse_workspaces(content: &str) -> Result<WorkspaceStore, String> {
    serde_json::from_str(content).map_err(|e| format!("Failed to parse workspaces file: {}", e))
}

pub fn save_workspaces(store: &WorkspaceStore) -> Result<(), String> {
    let dir = ensure_config_dir()?;
    let content = serde_json::to_string_pretty(store)
        .map_err(|e| format!("Failed to serialize workspaces: {}", e))?;
    fs::write(dir.join(FILE), content)
        .map_err(|e| format!("Failed to write workspaces file: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keep_defaults_to_everything() {
        let k = WorkspaceKeep::default();
        assert!(k.folder && k.tabs && k.view_mode && k.sidebar);
    }

    #[test]
    fn missing_keep_fields_are_kept() {
        let store = parse_workspaces(
            r#"{"active":"a","workspaces":[{"name":"a","keep":{"tabs":false}},{"name":"b"}]}"#,
        )
        .unwrap();
        let a = &store.workspaces[0].keep;
        assert!(!a.tabs);
        assert!(a.folder && a.view_mode && a.sidebar);
        assert_eq!(store.workspaces[1].keep, WorkspaceKeep::default());
        assert!(store.workspaces[1].session.is_none());
    }

    #[test]
    fn roundtrip_keeps_sessions_apart() {
        let work = Session {
            vault_path: Some("/work".to_string()),
            ..Session::default()
        };
        let notes = Session {
            vault_path: Some("/notes".to_string()),
            ..Session::default()
        };
        let store = WorkspaceStore {
            active: "notes".to_string(),
            workspaces: vec![
                Workspace {
                    name: "work".to_string(),
                    keep: WorkspaceKeep::default(),
                    session: Some(work),
                },
                Workspace {
                    name: "notes".to_string(),
                    keep: WorkspaceKeep {
                        tabs: false,
                        ..WorkspaceKeep::default()
                    },
                    session: Some(notes),
                },
            ],
        };
        let json = serde_json::to_string(&store).unwrap();
        let back = parse_workspaces(&json).unwrap();
        assert_eq!(back.active, "notes");
        assert_eq!(
            back.workspaces[0]
                .session
                .as_ref()
                .unwrap()
                .vault_path
                .as_deref(),
            Some("/work")
        );
        assert_eq!(
            back.workspaces[1]
                .session
                .as_ref()
                .unwrap()
                .vault_path
                .as_deref(),
            Some("/notes")
        );
        assert!(!back.workspaces[1].keep.tabs);
    }

    #[test]
    fn a_broken_file_is_an_error() {
        assert!(parse_workspaces("{not json").is_err());
        assert!(parse_workspaces(r#"{"workspaces":[]}"#).is_err()); // no active
    }
}
