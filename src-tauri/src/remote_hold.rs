//! Keep the way back from each set-up host open while the app runs.
//!
//! `fude-cli setup HOST` writes `RemoteForward PORT <this Fude>` into
//! `~/.ssh/config`, but a forward only exists while some ssh connection to
//! HOST carries it. Right after the app starts there may be none, and
//! `fude FILE` typed on HOST then reaches nothing until a connection is made
//! (running setup again happened to make one). So the app holds one itself:
//! `ssh -N HOST`, which picks the forward up from the config, brought back
//! whenever it drops.
//!
//! The ssh is a direct child (through `wsl.exe` with WSL integration on, the
//! process WSL runs for it), so it ends with the app and never outlives it.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// A connection that stayed up this long counts as having worked: the next
/// drop starts the waits over from the shortest.
const STEADY: Duration = Duration::from_secs(60);

/// The program and arguments that hold the forward to `host`.
///
/// Its own connection (no shared one: sessions the user opened must not
/// hang on the app, nor the app on them). `ExitOnForwardFailure` makes a
/// connection that could not get the port end, so it is tried again later
/// instead of sitting there doing nothing — the port is busy while another
/// connection of this machine's holds it, which serves just as well.
pub fn hold_command(host: &str, wsl_distro: Option<&str>) -> (String, Vec<String>) {
    let mut ssh: Vec<String> = [
        "ssh",
        "-N",
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ControlMaster=no",
        "-o",
        "ControlPath=none",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "ConnectTimeout=20",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    ssh.push(host.to_string());
    match wsl_distro {
        Some(distro) => {
            let mut args: Vec<String> =
                ["-d", distro, "-e"].iter().map(|s| s.to_string()).collect();
            args.extend(ssh);
            ("wsl.exe".to_string(), args)
        }
        None => {
            let program = ssh.remove(0);
            (program, ssh)
        }
    }
}

/// How long to wait before attempt `n` (0-based) after a drop: soon at
/// first, then once a minute for as long as the app runs.
pub fn retry_delay(n: usize) -> Duration {
    const STEPS: [u64; 5] = [2, 5, 10, 30, 60];
    Duration::from_secs(STEPS[n.min(STEPS.len() - 1)])
}

/// How one host's forward stands, for the settings panel.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct HoldStatus {
    pub host: String,
    /// The connection is up (it may still be waiting for the port).
    pub up: bool,
    /// What ssh said last, when it ended.
    pub last_error: String,
}

/// Hosts to start and hosts to stop to go from `running` to `wanted`.
pub fn plan_sync(running: &[String], wanted: &[String]) -> (Vec<String>, Vec<String>) {
    let start = wanted
        .iter()
        .filter(|h| !running.contains(h))
        .fold(Vec::new(), |mut v, h| {
            if !v.contains(h) {
                v.push(h.clone());
            }
            v
        });
    let stop = running
        .iter()
        .filter(|h| !wanted.contains(h))
        .cloned()
        .collect();
    (start, stop)
}

struct Hold {
    stop: Arc<AtomicBool>,
    child: Arc<Mutex<Option<Child>>>,
    up: Arc<AtomicBool>,
    last_error: Arc<Mutex<String>>,
    /// The command it runs: a change (WSL integration switched) restarts it.
    command: (String, Vec<String>),
}

impl Hold {
    fn end(&self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Ok(mut c) = self.child.lock() {
            if let Some(child) = c.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
            *c = None;
        }
    }
}

/// The forwards the app holds, one per host.
#[derive(Default)]
pub struct Manager {
    holds: Mutex<HashMap<String, Hold>>,
}

impl Manager {
    /// Hold a forward to each of `hosts` and to nothing else.
    pub fn sync(&self, hosts: &[String], wsl_distro: Option<&str>) {
        let Ok(mut holds) = self.holds.lock() else {
            return;
        };
        // A host whose command changed is started afresh.
        let stale: Vec<String> = holds
            .iter()
            .filter(|(h, hold)| hold.command != hold_command(h, wsl_distro))
            .map(|(h, _)| h.clone())
            .collect();
        for h in stale {
            if let Some(hold) = holds.remove(&h) {
                hold.end();
            }
        }
        let running: Vec<String> = holds.keys().cloned().collect();
        let (start, stop) = plan_sync(&running, hosts);
        for h in stop {
            if let Some(hold) = holds.remove(&h) {
                hold.end();
            }
        }
        for h in start {
            let hold = spawn_hold(hold_command(&h, wsl_distro));
            holds.insert(h, hold);
        }
    }

    /// Let every forward go (the app is ending).
    pub fn stop_all(&self) {
        if let Ok(mut holds) = self.holds.lock() {
            for (_, hold) in holds.drain() {
                hold.end();
            }
        }
    }

    pub fn status(&self) -> Vec<HoldStatus> {
        let Ok(holds) = self.holds.lock() else {
            return Vec::new();
        };
        let mut out: Vec<HoldStatus> = holds
            .iter()
            .map(|(h, hold)| HoldStatus {
                host: h.clone(),
                up: hold.up.load(Ordering::SeqCst),
                last_error: hold
                    .last_error
                    .lock()
                    .map(|s| s.clone())
                    .unwrap_or_default(),
            })
            .collect();
        out.sort_by(|a, b| a.host.cmp(&b.host));
        out
    }
}

/// Sleep `d`, waking early when `stop` is set. True when stopped.
fn nap(d: Duration, stop: &AtomicBool) -> bool {
    let until = Instant::now() + d;
    while Instant::now() < until {
        if stop.load(Ordering::SeqCst) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    stop.load(Ordering::SeqCst)
}

fn spawn_hold(command: (String, Vec<String>)) -> Hold {
    let hold = Hold {
        stop: Arc::new(AtomicBool::new(false)),
        child: Arc::new(Mutex::new(None)),
        up: Arc::new(AtomicBool::new(false)),
        last_error: Arc::new(Mutex::new(String::new())),
        command: command.clone(),
    };
    let stop = Arc::clone(&hold.stop);
    let slot = Arc::clone(&hold.child);
    let up = Arc::clone(&hold.up);
    let last_error = Arc::clone(&hold.last_error);
    std::thread::spawn(move || {
        let (program, args) = command;
        let mut failures = 0usize;
        while !stop.load(Ordering::SeqCst) {
            let mut cmd = Command::new(&program);
            cmd.args(&args)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped());
            crate::wsl_bridge::no_window(&mut cmd);
            let started = Instant::now();
            match cmd.spawn() {
                Ok(mut child) => {
                    let said = Arc::new(Mutex::new(String::new()));
                    if let Some(err) = child.stderr.take() {
                        let said = Arc::clone(&said);
                        std::thread::spawn(move || {
                            for line in BufReader::new(err).lines().map_while(Result::ok) {
                                let line = line.trim().to_string();
                                if !line.is_empty() {
                                    if let Ok(mut s) = said.lock() {
                                        *s = line;
                                    }
                                }
                            }
                        });
                    }
                    if let Ok(mut s) = slot.lock() {
                        if stop.load(Ordering::SeqCst) {
                            let _ = child.kill();
                            let _ = child.wait();
                            return;
                        }
                        *s = Some(child);
                    }
                    up.store(true, Ordering::SeqCst);
                    // Wait for it to end (or to be told to end).
                    loop {
                        if nap(Duration::from_millis(500), &stop) {
                            return;
                        }
                        let done = match slot.lock() {
                            Ok(mut s) => match s.as_mut() {
                                Some(c) => !matches!(c.try_wait(), Ok(None)),
                                None => true,
                            },
                            Err(_) => true,
                        };
                        if done {
                            break;
                        }
                    }
                    up.store(false, Ordering::SeqCst);
                    if let Ok(mut s) = slot.lock() {
                        *s = None;
                    }
                    // Give the reader a moment to take ssh's last words.
                    std::thread::sleep(Duration::from_millis(100));
                    let words = said.lock().map(|s| s.clone()).unwrap_or_default();
                    if let Ok(mut e) = last_error.lock() {
                        *e = words;
                    }
                }
                Err(e) => {
                    if let Ok(mut le) = last_error.lock() {
                        *le = format!("{} を実行できません: {}", program, e);
                    }
                }
            }
            if started.elapsed() >= STEADY {
                failures = 0;
            }
            let wait = retry_delay(failures);
            failures += 1;
            if nap(wait, &stop) {
                return;
            }
        }
    });
    hold
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn holds_with_its_own_connection_that_gives_up_without_the_port() {
        let (program, args) = hold_command("k16", None);
        assert_eq!(program, "ssh");
        assert_eq!(args.first().map(String::as_str), Some("-N"));
        assert_eq!(args.last().map(String::as_str), Some("k16"));
        for opt in [
            "BatchMode=yes",
            "ExitOnForwardFailure=yes",
            "ControlMaster=no",
            "ControlPath=none",
        ] {
            assert!(args.iter().any(|a| a == opt), "{opt} missing: {args:?}");
        }
        // The forward comes from ~/.ssh/config: nothing may clear it.
        assert!(!args.iter().any(|a| a.starts_with("ClearAllForwardings")));
    }

    #[test]
    fn with_wsl_integration_ssh_runs_inside_the_distro() {
        let (program, args) = hold_command("me@box", Some("Ubuntu"));
        assert_eq!(program, "wsl.exe");
        assert_eq!(&args[..4], &s(&["-d", "Ubuntu", "-e", "ssh"])[..]);
        assert_eq!(args.last().map(String::as_str), Some("me@box"));
    }

    #[test]
    fn retries_soon_at_first_then_once_a_minute() {
        assert_eq!(retry_delay(0), Duration::from_secs(2));
        assert!(retry_delay(1) > retry_delay(0));
        assert_eq!(retry_delay(4), Duration::from_secs(60));
        assert_eq!(retry_delay(1000), Duration::from_secs(60));
    }

    #[test]
    fn sync_starts_what_is_missing_and_stops_what_is_gone() {
        let (start, stop) = plan_sync(&s(&["a", "b"]), &s(&["b", "c", "c"]));
        assert_eq!(start, s(&["c"]));
        assert_eq!(stop, s(&["a"]));
        let (start, stop) = plan_sync(&[], &[]);
        assert!(start.is_empty() && stop.is_empty());
        let (start, stop) = plan_sync(&s(&["a"]), &[]);
        assert!(start.is_empty());
        assert_eq!(stop, s(&["a"]));
    }

    #[cfg(unix)]
    #[test]
    fn a_hold_is_brought_back_and_ends_when_told() {
        // A stand-in for ssh that ends at once, saying why.
        let hold = spawn_hold((
            "sh".to_string(),
            s(&["-c", "echo 'remote port forwarding failed' >&2; exit 255"]),
        ));
        std::thread::sleep(Duration::from_millis(1500));
        assert!(!hold.up.load(Ordering::SeqCst));
        assert_eq!(
            hold.last_error.lock().unwrap().as_str(),
            "remote port forwarding failed"
        );
        hold.end();
        assert!(hold.child.lock().unwrap().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn a_running_hold_is_up_and_ending_it_kills_the_process() {
        let hold = spawn_hold(("sleep".to_string(), s(&["30"])));
        std::thread::sleep(Duration::from_millis(700));
        assert!(hold.up.load(Ordering::SeqCst));
        let started = Instant::now();
        hold.end();
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(hold.child.lock().unwrap().is_none());
    }

    #[test]
    fn the_manager_reports_and_lets_go_of_its_hosts() {
        let m = Manager::default();
        m.sync(&[], None);
        assert!(m.status().is_empty());
        m.stop_all();
        assert!(m.status().is_empty());
    }
}
