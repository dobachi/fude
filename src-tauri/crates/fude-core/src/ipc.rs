//! Wire protocol between a running Fude GUI and a CLI client: `fude --wait`
//! on the same machine, or the `fude-cli` agent on a remote one that serves
//! the files it asked the GUI to open (docs/TUI_DESIGN.md §4.3).
//!
//! One connection is one session. Messages are JSON objects, one per line
//! (JSON Lines), tagged by `type`. File operations are requests from the GUI
//! to the client carrying an `id`, answered by one `result` with that id.

use interprocess::local_socket::{prelude::*, Name};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

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
        /// Set by a remote agent: the machine whose files it serves. The GUI
        /// shows it and keys the tab paths (`remote://<host>/...`) on it.
        #[serde(default)]
        host: Option<String>,
        /// Required from a remote agent: the GUI's secret (`token.rs`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        token: Option<String>,
    },
    /// The GUI's answer to `Hello`. Its arrival is what tells a client that a
    /// forwarded socket really reaches a running GUI (ssh accepts and then
    /// drops the connection when the far end is down).
    Welcome {
        protocol: u32,
        #[serde(default)]
        gui_version: Option<String>,
    },
    /// Ask the GUI to open `paths`. With `wait`, the client stays until every
    /// path has been reported `Closed`. A remote agent also lists the
    /// directories it serves (`roots`) so the GUI can route each request to
    /// the agent that can answer it.
    Open {
        paths: Vec<String>,
        wait: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        roots: Option<Vec<String>>,
    },
    /// The GUI accepted a path (sent once per path, with the resolved path).
    Opened {
        path: String,
    },
    /// The tab for `path` was closed. `saved` is false when unsaved changes
    /// were discarded on close.
    Closed {
        path: String,
        saved: bool,
    },
    /// Something went wrong with the request as a whole or with one path.
    Error {
        #[serde(default)]
        path: Option<String>,
        message: String,
    },
    /// Either side is done with the connection.
    Bye,

    // ── File operations: GUI → agent, answered by `Result` ──
    ReadFile {
        id: u64,
        path: String,
    },
    WriteFile {
        id: u64,
        path: String,
        content: String,
    },
    ReadDirTree {
        id: u64,
        path: String,
        #[serde(default)]
        show_all_files: bool,
    },
    /// Start reporting `FileChanged` for `path`.
    Watch {
        id: u64,
        path: String,
    },
    Unwatch {
        id: u64,
        path: String,
    },
    /// Answer to a request: exactly one of `ok` / `error` is set.
    Result {
        id: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ok: Option<serde_json::Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// agent → GUI: `path` changed on disk (not by the GUI's own write).
    FileChanged {
        path: String,
    },
}

impl Message {
    /// The request id, for messages that carry one.
    pub fn request_id(&self) -> Option<u64> {
        match self {
            Message::ReadFile { id, .. }
            | Message::WriteFile { id, .. }
            | Message::ReadDirTree { id, .. }
            | Message::Watch { id, .. }
            | Message::Unwatch { id, .. }
            | Message::Result { id, .. } => Some(*id),
            _ => None,
        }
    }

    pub fn ok(id: u64, value: serde_json::Value) -> Message {
        Message::Result {
            id,
            ok: Some(value),
            error: None,
        }
    }

    pub fn err(id: u64, error: impl Into<String>) -> Message {
        Message::Result {
            id,
            ok: None,
            error: Some(error.into()),
        }
    }
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

/// Prefix of a path that lives on a remote agent's machine.
pub const REMOTE_SCHEME: &str = "remote://";

/// `remote://<host><abs path>` — the tab path for a file served by the
/// agent on `host`. Mirrored in src/js/core/remote-path.js.
pub fn remote_path(host: &str, abs_path: &str) -> String {
    format!("{}{}{}", REMOTE_SCHEME, host, abs_path)
}

/// Split a `remote://<host><abs path>` into (host, path). The path starts at
/// the first `/` after the host, so Unix paths need no separator of their
/// own; a Windows path would appear as `remote://host/C:/...`.
pub fn split_remote_path(path: &str) -> Option<(&str, &str)> {
    let rest = path.strip_prefix(REMOTE_SCHEME)?;
    let slash = rest.find('/')?;
    let (host, p) = rest.split_at(slash);
    if host.is_empty() {
        return None;
    }
    Some((host, p))
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

/// The local-socket name for `socket`: a filesystem path where those are
/// supported, else (Windows) a named pipe derived from the file name.
pub fn socket_name(socket: &Path) -> std::io::Result<Name<'static>> {
    #[cfg(unix)]
    {
        use interprocess::local_socket::GenericFilePath;
        socket.to_path_buf().to_fs_name::<GenericFilePath>()
    }
    #[cfg(not(unix))]
    {
        use interprocess::local_socket::GenericNamespaced;
        let base = socket
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "fude-gui.sock".to_string());
        let user = std::env::var("USERNAME").unwrap_or_default();
        format!("fude-{}-{}", user, base).to_ns_name::<GenericNamespaced>()
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
            roots: Some(vec!["/abs".into()]),
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
                cli_version: None,
                host: None,
                token: None,
            }
        );
    }

    #[test]
    fn remote_paths_split_back_into_host_and_path() {
        let p = remote_path("box", "/home/u/a.md");
        assert_eq!(p, "remote://box/home/u/a.md");
        assert_eq!(split_remote_path(&p), Some(("box", "/home/u/a.md")));
        assert_eq!(split_remote_path("remote://box/"), Some(("box", "/")));
        assert_eq!(split_remote_path("remote:///x"), None);
        assert_eq!(split_remote_path("remote://box"), None);
        assert_eq!(split_remote_path("/local/a.md"), None);
    }

    #[test]
    fn open_roots_are_optional_on_the_wire() {
        let m = decode(r#"{"type":"open","paths":["a"],"wait":true}"#)
            .unwrap()
            .unwrap();
        assert_eq!(
            m,
            Message::Open {
                paths: vec!["a".into()],
                wait: true,
                roots: None
            }
        );
        assert!(!encode(&m).contains("roots"));
    }

    #[test]
    fn welcome_roundtrips() {
        let m = Message::Welcome {
            protocol: PROTOCOL_VERSION,
            gui_version: Some("0.8.0".into()),
        };
        assert_eq!(decode(&encode(&m)).unwrap(), Some(m));
    }

    #[test]
    fn requests_carry_ids_and_results_omit_the_unused_side() {
        let req = Message::ReadDirTree {
            id: 7,
            path: "/v".into(),
            show_all_files: false,
        };
        assert_eq!(req.request_id(), Some(7));
        assert_eq!(Message::Bye.request_id(), None);
        // `show_all_files` may be left out by older peers.
        let parsed = decode(r#"{"type":"read_dir_tree","id":7,"path":"/v"}"#)
            .unwrap()
            .unwrap();
        assert_eq!(parsed, req);

        let ok = encode(&Message::ok(7, serde_json::json!({"a": 1})));
        assert!(ok.contains(r#""ok":{"a":1}"#));
        assert!(!ok.contains("error"));
        let err = encode(&Message::err(7, "nope"));
        assert!(err.contains(r#""error":"nope""#));
        assert!(!err.contains(r#""ok""#));
        assert_eq!(
            decode(&err).unwrap().unwrap(),
            Message::Result {
                id: 7,
                ok: None,
                error: Some("nope".into())
            }
        );
    }

    #[test]
    fn file_changed_and_write_file_roundtrip() {
        for m in [
            Message::FileChanged { path: "/a".into() },
            Message::WriteFile {
                id: 1,
                path: "/a".into(),
                content: "x\ny".into(),
            },
            Message::Watch {
                id: 2,
                path: "/a".into(),
            },
        ] {
            assert_eq!(decode(&encode(&m)).unwrap(), Some(m));
        }
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
