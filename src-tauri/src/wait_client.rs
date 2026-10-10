//! `fude --wait <path>...`: open the paths in the running GUI (starting one
//! if needed) and block until their tabs are closed, so Fude can serve as
//! `$EDITOR` for git, Claude Code and friends.

use fude_core::ipc::{self, socket_name, Message, PROTOCOL_VERSION};
use fude_core::wait::{exit_code, WaitState};
use interprocess::local_socket::{prelude::*, Name, Stream};
use std::io::{self, BufRead, BufReader, Write};
use std::path::Path;
use std::time::{Duration, Instant};

/// How long to keep trying to reach a GUI we just launched.
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(20);
const RETRY_INTERVAL: Duration = Duration::from_millis(150);

/// The paths of a `--wait` invocation, or `None` when `--wait` / `-w` is not
/// present (argv[0] = executable). Flags that take a value (`--remote`) are
/// skipped together with their operand; anything after `--` is a path.
pub fn wait_paths(args: &[String]) -> Option<Vec<String>> {
    let mut wait = false;
    let mut paths = Vec::new();
    let mut i = 1;
    let mut operands_only = false;
    while i < args.len() {
        let a = &args[i];
        if operands_only {
            paths.push(a.clone());
        } else if a == "--" {
            operands_only = true;
        } else if a == "--wait" || a == "-w" {
            wait = true;
        } else if a == "--remote" || a == "-r" {
            i += 1;
        } else if a.starts_with('-') {
            // other flags are irrelevant to the wait client
        } else {
            paths.push(a.clone());
        }
        i += 1;
    }
    wait.then_some(paths)
}

/// Run the wait client to completion and return the process exit code.
pub fn run(paths: Vec<String>, socket: &Path) -> i32 {
    if paths.is_empty() {
        eprintln!("fude: --wait needs at least one path");
        return 2;
    }
    let name = match socket_name(socket) {
        Ok(n) => n,
        Err(e) => {
            eprintln!("fude: {}", e);
            return 2;
        }
    };

    let stream = match Stream::connect(name.clone()) {
        Ok(s) => s,
        Err(_) => {
            if let Err(e) = launch_gui() {
                eprintln!("fude: could not start the GUI: {}", e);
                return 2;
            }
            match connect_with_retry(&name, LAUNCH_TIMEOUT) {
                Some(s) => s,
                None => {
                    eprintln!(
                        "fude: the GUI did not answer on {} within {:?}",
                        socket.display(),
                        LAUNCH_TIMEOUT
                    );
                    return 2;
                }
            }
        }
    };

    match talk(stream, paths) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("fude: {}", e);
            2
        }
    }
}

fn talk(stream: Stream, paths: Vec<String>) -> io::Result<i32> {
    let (recv, mut send) = stream.split();
    let cwd = std::env::current_dir()
        .ok()
        .map(|p| p.to_string_lossy().to_string());
    let mut out = String::new();
    out.push_str(&ipc::encode(&Message::Hello {
        protocol: PROTOCOL_VERSION,
        cwd,
        cli_version: Some(env!("CARGO_PKG_VERSION").to_string()),
        host: None,
        token: None,
    }));
    out.push_str(&ipc::encode(&Message::Open {
        paths: paths.clone(),
        wait: true,
        roots: None,
    }));
    send.write_all(out.as_bytes())?;
    send.flush()?;

    let mut state = WaitState::new(paths.len());
    let mut reader = BufReader::new(recv);
    let mut line = String::new();
    while !state.done() {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => state.disconnected(),
            Ok(_) => match ipc::decode(&line) {
                Ok(Some(msg)) => {
                    if let Some(text) = state.handle(&msg) {
                        eprintln!("{}", text);
                    }
                }
                Ok(None) => {}
                Err(e) => eprintln!("fude: {}", e),
            },
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => state.disconnected(),
        }
    }
    let _ = send.write_all(ipc::encode(&Message::Bye).as_bytes());
    Ok(exit_code(&state.outcomes()))
}

fn connect_with_retry(name: &Name<'static>, timeout: Duration) -> Option<Stream> {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if let Ok(s) = Stream::connect(name.clone()) {
            return Some(s);
        }
        std::thread::sleep(RETRY_INTERVAL);
    }
    None
}

/// Start a detached GUI process (no arguments: it restores its session and
/// then accepts our `open`). stdio is detached so a terminal caller is not
/// held by the GUI's output.
fn launch_gui() -> io::Result<()> {
    let exe = std::env::current_exe()?;
    let mut cmd = std::process::Command::new(exe);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // New session so a Ctrl+C in the terminal does not take the GUI down.
        cmd.process_group(0);
    }
    cmd.spawn().map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn wait_paths_requires_the_flag() {
        assert_eq!(wait_paths(&args(&["fude", "a.md"])), None);
        assert_eq!(wait_paths(&args(&["fude"])), None);
        assert_eq!(wait_paths(&[]), None);
    }

    #[test]
    fn wait_paths_collects_every_operand_in_order() {
        assert_eq!(
            wait_paths(&args(&["fude", "--wait", "a.md", "b.md"])),
            Some(vec!["a.md".to_string(), "b.md".to_string()])
        );
        assert_eq!(
            wait_paths(&args(&["fude", "a.md", "-w"])),
            Some(vec!["a.md".to_string()])
        );
        assert_eq!(wait_paths(&args(&["fude", "-w"])), Some(vec![]));
    }

    #[test]
    fn wait_paths_skips_remote_value_and_honours_double_dash() {
        assert_eq!(
            wait_paths(&args(&["fude", "-w", "-r", "http://x", "a.md"])),
            Some(vec!["a.md".to_string()])
        );
        assert_eq!(
            wait_paths(&args(&["fude", "--wait", "-n", "--", "--odd.md"])),
            Some(vec!["--odd.md".to_string()])
        );
        // `--wait` after `--` is a file name, not the flag.
        assert_eq!(wait_paths(&args(&["fude", "--", "--wait"])), None);
    }
}
