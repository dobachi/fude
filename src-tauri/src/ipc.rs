//! Wire protocol between a running Fude GUI and a `fude --wait` client.
//!
//! One connection is one session. Messages are JSON objects, one per line
//! (JSON Lines), tagged by `type`. The same protocol is meant to carry the
//! remote-GUI agent later (see docs/TUI_DESIGN.md §4.3), so file operations
//! will be added here as further variants rather than as a second channel.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Bumped whenever a change would confuse an older peer.
pub const PROTOCOL_VERSION: u32 = 1;

/// Environment variable that overrides where the GUI socket lives.
pub const SOCKET_ENV: &str = "FUDE_GUI_SOCK";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Message {
    /// First message from the client.
    Hello {
        protocol: u32,
        /// Working directory relative paths in `Open` are resolved against.
        #[serde(default)]
        cwd: Option<String>,
        #[serde(default)]
        cli_version: Option<String>,
    },
    /// Ask the GUI to open `paths`. With `wait`, the client stays until every
    /// path has been reported `Closed`.
    Open { paths: Vec<String>, wait: bool },
    /// The GUI accepted a path (sent once per path, with the resolved path).
    Opened { path: String },
    /// The tab for `path` was closed. `saved` is false when unsaved changes
    /// were discarded on close.
    Closed { path: String, saved: bool },
    /// Something went wrong with the request as a whole or with one path.
    Error {
        #[serde(default)]
        path: Option<String>,
        message: String,
    },
    /// Either side is done with the connection.
    Bye,
}

/// Serialize a message as one JSON line (trailing newline included).
pub fn encode(msg: &Message) -> String {
    // Message contains only strings/bools/ints, so serialization cannot fail.
    let mut s = serde_json::to_string(msg).unwrap_or_default();
    s.push('\n');
    s
}

/// Parse one line. Blank lines are not messages (`None`); malformed input is
/// an error so the peer can be told rather than silently ignored.
pub fn decode(line: &str) -> Result<Option<Message>, String> {
    let line = line.trim();
    if line.is_empty() {
        return Ok(None);
    }
    serde_json::from_str(line)
        .map(Some)
        .map_err(|e| format!("invalid message: {}", e))
}

/// Where the GUI listens. `FUDE_GUI_SOCK` wins; otherwise the config dir
/// (`~/.config/fude/gui.sock` on Linux), which is also what an ssh
/// `RemoteForward` line would name on the operator side.
pub fn socket_path(config_dir: &std::path::Path) -> PathBuf {
    match std::env::var_os(SOCKET_ENV) {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => config_dir.join("gui.sock"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_roundtrips_through_a_single_line() {
        let msg = Message::Open {
            paths: vec!["a.md".into(), "/abs/b.md".into()],
            wait: true,
        };
        let line = encode(&msg);
        assert!(line.ends_with('\n'));
        assert_eq!(line.matches('\n').count(), 1);
        assert_eq!(decode(&line).unwrap(), Some(msg));
    }

    #[test]
    fn messages_are_tagged_by_type_in_snake_case() {
        let line = encode(&Message::Closed {
            path: "/x.md".into(),
            saved: false,
        });
        let v: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(v["type"], "closed");
        assert_eq!(v["path"], "/x.md");
        assert_eq!(v["saved"], false);
    }

    #[test]
    fn hello_optional_fields_may_be_absent() {
        let msg = decode(r#"{"type":"hello","protocol":1}"#).unwrap().unwrap();
        assert_eq!(
            msg,
            Message::Hello {
                protocol: 1,
                cwd: None,
                cli_version: None
            }
        );
    }

    #[test]
    fn blank_lines_are_skipped_and_garbage_is_an_error() {
        assert_eq!(decode("   \n").unwrap(), None);
        assert!(decode("not json").is_err());
        assert!(decode(r#"{"type":"nope"}"#).is_err());
    }

    #[test]
    fn socket_path_prefers_the_env_override() {
        let dir = std::path::Path::new("/cfg");
        // The env var is process-global; keep the two cases in one test so
        // they cannot interleave with each other.
        std::env::remove_var(SOCKET_ENV);
        assert_eq!(socket_path(dir), PathBuf::from("/cfg/gui.sock"));
        std::env::set_var(SOCKET_ENV, "/tmp/custom.sock");
        assert_eq!(socket_path(dir), PathBuf::from("/tmp/custom.sock"));
        std::env::set_var(SOCKET_ENV, "");
        assert_eq!(socket_path(dir), PathBuf::from("/cfg/gui.sock"));
        std::env::remove_var(SOCKET_ENV);
    }
}
