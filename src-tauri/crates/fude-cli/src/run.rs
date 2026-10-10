//! The agent's main loop: connect to a GUI, ask it to open our paths, serve
//! its file requests and report changes until every tab is closed.

use crate::agent::{Agent, Side};
use crate::args::Args;
use crate::discover::{self, Connected};
use crate::watch::Watcher;
use fude_core::ipc::{self, Message, PROTOCOL_VERSION};
use fude_core::wait::{exit_code, WaitState};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;

/// The name this machine is announced under: `$FUDE_HOST`, else the hostname.
pub fn host_name() -> String {
    if let Ok(h) = std::env::var("FUDE_HOST") {
        if !h.trim().is_empty() {
            return h.trim().to_string();
        }
    }
    if let Ok(h) = std::env::var("HOSTNAME") {
        if !h.trim().is_empty() {
            return h.trim().to_string();
        }
    }
    if let Ok(h) = std::fs::read_to_string("/etc/hostname") {
        if !h.trim().is_empty() {
            return h.trim().to_string();
        }
    }
    "remote".to_string()
}

/// Where a detached agent's output goes.
pub fn log_path(cache_dir: &Path) -> PathBuf {
    cache_dir.join("fude").join("agent.log")
}

enum Event {
    Line(String),
    Eof,
    Changed(PathBuf),
}

/// Resolve the operands against the working directory.
pub fn absolute_paths(paths: &[String]) -> Vec<String> {
    let cwd = std::env::current_dir().ok();
    paths
        .iter()
        .map(|p| fude_core::resolve_cli_path(p, cwd.clone()))
        .collect()
}

/// Connect, or explain why not. `candidates` are tried in order.
pub fn connect(candidates: &[PathBuf]) -> Result<Connected, String> {
    let hello = Message::Hello {
        protocol: PROTOCOL_VERSION,
        cwd: std::env::current_dir()
            .ok()
            .map(|p| p.to_string_lossy().to_string()),
        cli_version: Some(env!("CARGO_PKG_VERSION").to_string()),
        host: Some(host_name()),
    };
    discover::connect_any(candidates, &hello).map_err(|reasons| {
        let mut msg = String::from("no Fude GUI reachable:");
        for r in reasons {
            msg.push_str("\n  ");
            msg.push_str(&r);
        }
        msg
    })
}

/// Serve `paths` over `conn` until their tabs are closed. Returns the exit
/// code (`fude_core::wait::exit_code`).
pub fn serve(mut conn: Connected, paths: Vec<String>, announce: bool) -> i32 {
    let agent = Agent::new(&paths);
    if announce {
        eprintln!(
            "fude-cli: serving {} to Fude {} via {}",
            agent
                .roots()
                .iter()
                .map(|r| r.to_string_lossy().to_string())
                .collect::<Vec<_>>()
                .join(", "),
            conn.gui_version.as_deref().unwrap_or("?"),
            conn.socket.display()
        );
    }
    let (tx, rx) = mpsc::channel::<Event>();

    let (wtx, wrx) = mpsc::channel::<PathBuf>();
    let mut watcher = match Watcher::new(wtx) {
        Ok(w) => Some(w),
        Err(e) => {
            eprintln!("fude-cli: {} (changes on disk will not be reported)", e);
            None
        }
    };
    let changed_tx = tx.clone();
    thread::spawn(move || {
        for p in wrx {
            if changed_tx.send(Event::Changed(p)).is_err() {
                return;
            }
        }
    });

    let reader_tx = tx;
    let mut reader =
        std::mem::replace(&mut conn.reader, std::io::BufReader::new(dummy_recv_half()));
    thread::spawn(move || {
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => {
                    let _ = reader_tx.send(Event::Eof);
                    return;
                }
                Ok(_) => {
                    if reader_tx.send(Event::Line(line.clone())).is_err() {
                        return;
                    }
                }
            }
        }
    });

    let open = Message::Open {
        paths: paths.clone(),
        wait: true,
        roots: Some(
            agent
                .roots()
                .iter()
                .map(|r| r.to_string_lossy().to_string())
                .collect(),
        ),
    };
    if conn
        .writer
        .write_all(ipc::encode(&open).as_bytes())
        .is_err()
    {
        eprintln!("fude-cli: connection lost before the GUI could open anything");
        return 2;
    }
    let _ = conn.writer.flush();

    let mut state = WaitState::new(paths.len());
    let mut noop = NoWatch;
    while !state.done() {
        let Ok(ev) = rx.recv() else { break };
        let reply = match ev {
            Event::Line(line) => match ipc::decode(&line) {
                Ok(Some(msg)) => {
                    if let Some(text) = state.handle(&msg) {
                        eprintln!("{}", text);
                    }
                    let side: &mut dyn Side = match watcher.as_mut() {
                        Some(w) => w,
                        None => &mut noop,
                    };
                    agent.handle(&msg, side)
                }
                Ok(None) => None,
                Err(e) => {
                    eprintln!("fude-cli: {}", e);
                    None
                }
            },
            Event::Changed(p) => Some(Message::FileChanged {
                path: p.to_string_lossy().to_string(),
            }),
            Event::Eof => {
                state.disconnected();
                None
            }
        };
        if let Some(m) = reply {
            if conn.writer.write_all(ipc::encode(&m).as_bytes()).is_err() {
                state.disconnected();
            }
            let _ = conn.writer.flush();
        }
    }
    let _ = conn.writer.write_all(ipc::encode(&Message::Bye).as_bytes());
    exit_code(&state.outcomes())
}

/// Stand-in for the reader half once it has been handed to its thread.
fn dummy_recv_half() -> interprocess::local_socket::RecvHalf {
    // A connected pair that is immediately dropped on one side: reads
    // return EOF, which is never observed because the real reader thread
    // owns the live half.
    use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions, Stream};
    let dir = std::env::temp_dir();
    let path = dir.join(format!("fude-cli-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let name = path
        .clone()
        .to_fs_name::<GenericFilePath>()
        .expect("temp socket name");
    let listener = ListenerOptions::new()
        .name(name.clone())
        .create_sync()
        .expect("temp listener");
    let client = Stream::connect(name).expect("temp connect");
    let _ = std::fs::remove_file(&path);
    drop(listener);
    client.split().0
}

struct NoWatch;
impl Side for NoWatch {
    fn before_write(&mut self, _path: &Path) {}
    fn watch(&mut self, _path: &Path) -> Result<(), String> {
        Err("file watching unavailable".into())
    }
    fn unwatch(&mut self, _path: &Path) -> Result<(), String> {
        Ok(())
    }
}

/// Re-run ourselves detached so the shell gets its prompt back while the
/// agent keeps serving files. Output goes to the log file.
pub fn detach(args: &Args, log: &Path) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    if let Some(dir) = log.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let open_log = || {
        std::fs::File::options()
            .create(true)
            .append(true)
            .open(log)
            .map_err(|e| format!("cannot open {}: {}", log.display(), e))
    };
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("--_foreground");
    if args.gui {
        cmd.arg("--gui");
    }
    cmd.arg("--");
    cmd.args(&args.paths);
    cmd.stdin(std::process::Stdio::null())
        .stdout(open_log()?)
        .stderr(open_log()?);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_name_prefers_the_override() {
        std::env::set_var("FUDE_HOST", "box.example");
        assert_eq!(host_name(), "box.example");
        std::env::set_var("FUDE_HOST", "  ");
        assert_ne!(host_name(), "  ");
        std::env::remove_var("FUDE_HOST");
        assert!(!host_name().is_empty());
    }

    #[test]
    fn absolute_paths_resolve_relative_operands() {
        let cwd = std::env::current_dir().unwrap();
        let out = absolute_paths(&["x.md".into(), "/abs/y.md".into()]);
        assert_eq!(out[0], cwd.join("x.md").to_string_lossy());
        assert_eq!(out[1], "/abs/y.md");
    }

    #[test]
    fn log_path_lives_under_the_cache_dir() {
        assert_eq!(
            log_path(Path::new("/c")),
            PathBuf::from("/c/fude/agent.log")
        );
    }
}
