//! `fude --wait <path>...`: open the paths in the running GUI (starting one
//! if needed) and block until their tabs are closed, so Fude can serve as
//! `$EDITOR` for git, Claude Code and friends.

use fude_core::ipc::{self, socket_name, Message, PROTOCOL_VERSION};
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

/// Outcome of one waited path.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Closed { saved: bool },
    Failed(String),
}

/// Process exit code: 0 only when every tab closed with its content saved
/// (or unchanged). Discarded edits and paths the GUI could not open are
/// failures, so a caller like `git commit` treats them as an abort.
pub fn exit_code(outcomes: &[Outcome]) -> i32 {
    if outcomes
        .iter()
        .all(|o| matches!(o, Outcome::Closed { saved: true }))
    {
        0
    } else {
        1
    }
}

/// What the client does with each line from the GUI while waiting.
/// Returns `true` once every path has an outcome.
#[derive(Debug, Default)]
pub struct WaitState {
    outcomes: Vec<(String, Outcome)>,
    /// Paths we have been told are open but not yet closed.
    open: Vec<String>,
    /// Count of paths we asked for; `Opened`/`Error` each account for one.
    expected: usize,
    done: bool,
}

impl WaitState {
    pub fn new(expected: usize) -> Self {
        WaitState {
            expected,
            ..Default::default()
        }
    }

    pub fn outcomes(&self) -> Vec<Outcome> {
        self.outcomes.iter().map(|(_, o)| o.clone()).collect()
    }

    pub fn done(&self) -> bool {
        self.done
    }

    /// Feed one message. Returns a line to show the user, if any.
    pub fn handle(&mut self, msg: Message) -> Option<String> {
        match msg {
            Message::Opened { path } => {
                self.open.push(path);
                None
            }
            Message::Closed { path, saved } => {
                self.open.retain(|p| p != &path);
                self.outcomes.push((path, Outcome::Closed { saved }));
                self.check_done();
                None
            }
            Message::Error { path, message } => {
                let shown = match &path {
                    Some(p) => format!("fude: {}: {}", p, message),
                    None => format!("fude: {}", message),
                };
                self.outcomes
                    .push((path.unwrap_or_default(), Outcome::Failed(message)));
                self.check_done();
                Some(shown)
            }
            Message::Bye => {
                self.done = true;
                None
            }
            Message::Hello { .. } | Message::Open { .. } => None,
        }
    }

    /// The GUI hung up. Paths still open count as closed-and-saved: the GUI
    /// quit, and quitting already prompts about unsaved changes.
    pub fn disconnected(&mut self) {
        for p in self.open.drain(..) {
            self.outcomes.push((p, Outcome::Closed { saved: true }));
        }
        self.done = true;
    }

    fn check_done(&mut self) {
        if self.outcomes.len() >= self.expected && self.open.is_empty() {
            self.done = true;
        }
    }
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
    }));
    out.push_str(&ipc::encode(&Message::Open {
        paths: paths.clone(),
        wait: true,
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
                    if let Some(text) = state.handle(msg) {
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

    #[test]
    fn exit_code_is_zero_only_when_everything_was_saved() {
        assert_eq!(exit_code(&[Outcome::Closed { saved: true }]), 0);
        assert_eq!(
            exit_code(&[
                Outcome::Closed { saved: true },
                Outcome::Closed { saved: false }
            ]),
            1
        );
        assert_eq!(exit_code(&[Outcome::Failed("x".into())]), 1);
        assert_eq!(exit_code(&[]), 0);
    }

    #[test]
    fn wait_state_completes_when_every_path_is_closed() {
        let mut st = WaitState::new(2);
        st.handle(Message::Opened { path: "/a".into() });
        st.handle(Message::Opened { path: "/b".into() });
        assert!(!st.done());
        st.handle(Message::Closed {
            path: "/a".into(),
            saved: true,
        });
        assert!(!st.done());
        st.handle(Message::Closed {
            path: "/b".into(),
            saved: false,
        });
        assert!(st.done());
        assert_eq!(exit_code(&st.outcomes()), 1);
    }

    #[test]
    fn wait_state_counts_errors_toward_completion() {
        let mut st = WaitState::new(2);
        let shown = st.handle(Message::Error {
            path: Some("/bad".into()),
            message: "cannot open".into(),
        });
        assert_eq!(shown.as_deref(), Some("fude: /bad: cannot open"));
        st.handle(Message::Opened { path: "/ok".into() });
        assert!(!st.done());
        st.handle(Message::Closed {
            path: "/ok".into(),
            saved: true,
        });
        assert!(st.done());
        assert_eq!(exit_code(&st.outcomes()), 1);
    }

    #[test]
    fn wait_state_treats_a_hangup_as_saved() {
        let mut st = WaitState::new(1);
        st.handle(Message::Opened { path: "/a".into() });
        st.disconnected();
        assert!(st.done());
        assert_eq!(st.outcomes(), vec![Outcome::Closed { saved: true }]);
    }

    #[test]
    fn bye_from_the_gui_ends_the_wait() {
        let mut st = WaitState::new(1);
        st.handle(Message::Bye);
        assert!(st.done());
    }
}
