//! Fude logic that does not depend on Tauri: files, session, config, the
//! autosave temp files, folder browsing, CLI path resolution and the IPC
//! protocol. The desktop app (`fude_lib`) wraps these as Tauri commands;
//! the remote agent and the TUI (see docs/TUI_DESIGN.md) use them directly.

pub mod browse;
pub mod cli;
pub mod config;
pub mod files;
pub mod ipc;
pub mod paths;
pub mod session;
pub mod temp;
pub mod wait;

pub use browse::*;
pub use cli::*;
pub use config::*;
pub use files::*;
pub use paths::*;
pub use session::*;
pub use temp::*;
